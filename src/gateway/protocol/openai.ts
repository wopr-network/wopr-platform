/**
 * OpenAI protocol handler — accepts OpenAI Chat Completions API format at /v1/openai/*.
 *
 * The OpenAI SDK authenticates via Authorization: Bearer header. This handler:
 * 1. Validates the tenant token from the bearer token
 * 2. Budget-checks the tenant
 * 3. Forwards to the cheapest OpenAI-compatible provider
 * 4. Meters usage from the response
 * 5. Returns the OpenAI-format response unchanged
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { logger } from "../../config/logger.js";
import { llmBodyLimit } from "../body-limit.js";
import { capabilityRateLimit } from "../capability-rate-limit.js";
import { circuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../circuit-breaker.js";
import { creditBalanceCheck, debitCredits } from "../credit-gate.js";
import { resolveTokenRates } from "../rate-lookup.js";
import type { GatewayAuthEnv } from "../service-key-auth.js";
import type { GatewayTenant } from "../types.js";
import type { ProtocolDeps } from "./deps.js";

// ---------------------------------------------------------------------------
// Auth middleware — OpenAI SDK sends Authorization: Bearer
// ---------------------------------------------------------------------------

function openaiAuth(resolveServiceKey: (key: string) => GatewayTenant | null) {
  return async (c: Context<GatewayAuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return c.json(
        {
          error: {
            message: "Missing Authorization header. Expected: Bearer <api_key>",
            type: "invalid_request_error",
            param: null,
            code: "missing_api_key",
          },
        },
        401,
      );
    }

    if (!authHeader.trim().toLowerCase().startsWith("bearer ")) {
      return c.json(
        {
          error: {
            message: "Invalid Authorization header format. Expected: Bearer <api_key>",
            type: "invalid_request_error",
            param: null,
            code: "invalid_auth_format",
          },
        },
        401,
      );
    }

    const key = authHeader.trim().slice(7).trim();
    if (!key) {
      return c.json(
        {
          error: {
            message: "Empty API key",
            type: "invalid_request_error",
            param: null,
            code: "missing_api_key",
          },
        },
        401,
      );
    }

    const tenant = resolveServiceKey(key);
    if (!tenant) {
      logger.warn("Invalid service key attempted (openai handler)", {
        keyPrefix: `${key.slice(0, 8)}...`,
      });
      return c.json(
        {
          error: {
            message: "Incorrect API key provided. You can find your API key at https://api.wopr.bot/settings.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    c.set("gatewayTenant", tenant);
    return next();
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the OpenAI protocol router.
 *
 * Mounts at /v1/openai — the OpenAI SDK will target paths like:
 *   /v1/openai/v1/chat/completions
 *   /v1/openai/v1/embeddings
 *
 * @param deps - Shared protocol handler dependencies
 * @returns Hono router for the OpenAI protocol
 */
export function createOpenAIRoutes(deps: ProtocolDeps): Hono<GatewayAuthEnv> {
  const app = new Hono<GatewayAuthEnv>();

  app.use("/*", openaiAuth(deps.resolveServiceKey));

  // Rate limiting for protocol routes (these bypass the main gateway rate limiters)
  app.use("/*", capabilityRateLimit(deps.capabilityRateLimitConfig, deps.rateLimitRepo));
  app.use(
    "/*",
    circuitBreaker({
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...deps.circuitBreakerConfig,
      repo: deps.circuitBreakerRepo,
      onTrip: deps.onCircuitBreakerTrip,
    }),
  );

  // Body size limit — prevent memory exhaustion from oversized payloads (WOP-655)
  app.use("/*", llmBodyLimit());

  // POST /v1/chat/completions
  app.post("/v1/chat/completions", chatCompletionsHandler(deps));

  // POST /v1/embeddings
  app.post("/v1/embeddings", embeddingsHandler(deps));

  return app;
}

// ---------------------------------------------------------------------------
// Chat Completions — POST /v1/chat/completions
// ---------------------------------------------------------------------------

function chatCompletionsHandler(deps: ProtocolDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    // Budget check
    const budgetResult = deps.budgetChecker.check(tenant.id, tenant.spendLimits);
    if (!budgetResult.allowed) {
      return c.json(
        {
          error: {
            message: budgetResult.reason ?? "Budget exceeded",
            type: "insufficient_quota",
            param: null,
            code: "insufficient_quota",
          },
        },
        429,
      );
    }

    // Credit balance check (estimate minimum 1 cent for LLM calls)
    const creditErr = creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      // Convert to OpenAI error format
      return c.json(
        {
          error: {
            message: creditErr.message,
            type: creditErr.type,
            param: null,
            code: creditErr.code,
          },
        },
        402,
      );
    }

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "LLM service not configured",
            type: "server_error",
            param: null,
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const body = await c.req.text();
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

      // Detect streaming and extract model before forwarding
      let isStreaming = false;
      let requestModel: string | undefined;
      try {
        const parsed = JSON.parse(body) as { stream?: boolean; model?: string };
        isStreaming = parsed.stream === true;
        requestModel = parsed.model;
      } catch {
        // If body isn't valid JSON, proceed without streaming detection
      }

      const res = await deps.fetchFn(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      // For streaming responses, pipe the SSE stream through without JSON parsing.
      // Cost estimation requires a JSON body, so skip it for streams.
      if (isStreaming && res.ok) {
        const costHeader = res.headers.get("x-openrouter-cost");
        const cost = costHeader ? parseFloat(costHeader) : 0;

        logger.info("OpenAI handler: chat/completions (streaming)", {
          tenant: tenant.id,
          status: res.status,
          cost,
        });

        if (cost > 0) {
          deps.meter.emit({
            tenant: tenant.id,
            cost,
            charge: deps.withMarginFn(cost, deps.defaultMargin),
            capability: "chat-completions",
            provider: "openrouter",
            timestamp: Date.now(),
          });
          debitCredits(deps, tenant.id, cost, deps.defaultMargin, "chat-completions", "openrouter");
        }

        return new Response(res.body, {
          status: res.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const responseBody = await res.text();
      const costHeader = res.headers.get("x-openrouter-cost");
      const cost = costHeader ? parseFloat(costHeader) : estimateTokenCostFromBody(responseBody, requestModel, deps);

      logger.info("OpenAI handler: chat/completions", {
        tenant: tenant.id,
        status: res.status,
        cost,
      });

      if (res.ok) {
        deps.meter.emit({
          tenant: tenant.id,
          cost,
          charge: deps.withMarginFn(cost, deps.defaultMargin),
          capability: "chat-completions",
          provider: "openrouter",
          timestamp: Date.now(),
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "chat-completions", "openrouter");
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      logger.error("OpenAI handler: chat/completions error", { tenant: tenant.id, error });
      const err = error instanceof Error ? error : new Error(String(error));
      return c.json(
        {
          error: {
            message: err.message,
            type: "server_error",
            param: null,
            code: "internal_error",
          },
        },
        500,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Embeddings — POST /v1/embeddings
// ---------------------------------------------------------------------------

function embeddingsHandler(deps: ProtocolDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    // Budget check
    const budgetResult = deps.budgetChecker.check(tenant.id, tenant.spendLimits);
    if (!budgetResult.allowed) {
      return c.json(
        {
          error: {
            message: budgetResult.reason ?? "Budget exceeded",
            type: "insufficient_quota",
            param: null,
            code: "insufficient_quota",
          },
        },
        429,
      );
    }

    // Credit balance check (estimate minimum 1 cent for LLM calls)
    const creditErr = creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      // Convert to OpenAI error format
      return c.json(
        {
          error: {
            message: creditErr.message,
            type: creditErr.type,
            param: null,
            code: creditErr.code,
          },
        },
        402,
      );
    }

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "Embeddings service not configured",
            type: "server_error",
            param: null,
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const body = await c.req.text();
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

      const res = await deps.fetchFn(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      const responseBody = await res.text();
      const costHeader = res.headers.get("x-openrouter-cost");
      const cost = costHeader ? parseFloat(costHeader) : 0.0001;

      logger.info("OpenAI handler: embeddings", {
        tenant: tenant.id,
        status: res.status,
        cost,
      });

      if (res.ok) {
        deps.meter.emit({
          tenant: tenant.id,
          cost,
          charge: deps.withMarginFn(cost, deps.defaultMargin),
          capability: "embeddings",
          provider: "openrouter",
          timestamp: Date.now(),
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "embeddings", "openrouter");
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      logger.error("OpenAI handler: embeddings error", { tenant: tenant.id, error });
      const err = error instanceof Error ? error : new Error(String(error));
      return c.json(
        {
          error: {
            message: err.message,
            type: "server_error",
            param: null,
            code: "internal_error",
          },
        },
        500,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokenCostFromBody(body: string, model?: string, deps?: ProtocolDeps): number {
  try {
    const parsed = JSON.parse(body) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inputTokens = parsed.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed.usage?.completion_tokens ?? 0;
    const rates = resolveTokenRates(deps?.rateLookupFn ?? (() => null), "chat-completions", model);
    return (inputTokens * rates.inputRatePer1K + outputTokens * rates.outputRatePer1K) / 1000;
  } catch {
    return 0.001;
  }
}
