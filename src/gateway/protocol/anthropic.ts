/**
 * Anthropic protocol handler — accepts Anthropic Messages API format at /v1/anthropic/*.
 *
 * The Anthropic SDK authenticates via x-api-key header. This handler:
 * 1. Validates the tenant token from x-api-key
 * 2. Budget-checks the tenant
 * 3. Routes the request (currently always via OpenRouter with format translation)
 * 4. Translates response back to Anthropic format
 * 5. Meters usage from the response usage block
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { logger } from "../../config/logger.js";
import type { GatewayAuthEnv } from "../service-key-auth.js";
import type { GatewayTenant } from "../types.js";
import type { ProtocolDeps } from "./deps.js";
import {
  type AnthropicError,
  type AnthropicRequest,
  type OpenAIResponse,
  anthropicToOpenAI,
  estimateAnthropicCost,
  mapToAnthropicError,
  openAIResponseToAnthropic,
} from "./translate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return an Anthropic-format error as a raw Response (supports non-standard status codes like 529). */
function anthropicErrorResponse(status: number, body: AnthropicError): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Auth middleware — Anthropic SDK sends x-api-key instead of Authorization
// ---------------------------------------------------------------------------

function anthropicAuth(resolveServiceKey: (key: string) => GatewayTenant | null) {
  return async (c: Context<GatewayAuthEnv>, next: Next) => {
    // Anthropic SDK uses x-api-key header
    const apiKey = c.req.header("x-api-key");

    // Also accept Authorization: Bearer for flexibility
    const authHeader = c.req.header("Authorization");
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    const key = apiKey || bearerKey;

    if (!key) {
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Missing x-api-key header",
          },
        },
        401,
      );
    }

    const tenant = resolveServiceKey(key);
    if (!tenant) {
      logger.warn("Invalid service key attempted (anthropic handler)", {
        keyPrefix: `${key.slice(0, 8)}...`,
      });
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Invalid or expired API key",
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
 * Create the Anthropic protocol router.
 *
 * Mounts at /v1/anthropic — the Anthropic SDK will target paths like:
 *   /v1/anthropic/v1/messages
 *
 * @param deps - Shared protocol handler dependencies
 * @returns Hono router for the Anthropic protocol
 */
export function createAnthropicRoutes(deps: ProtocolDeps): Hono<GatewayAuthEnv> {
  const app = new Hono<GatewayAuthEnv>();

  app.use("/*", anthropicAuth(deps.resolveServiceKey));

  // POST /v1/messages — the main Messages API endpoint
  app.post("/v1/messages", messagesHandler(deps));

  return app;
}

// ---------------------------------------------------------------------------
// Messages handler — POST /v1/messages
// ---------------------------------------------------------------------------

function messagesHandler(deps: ProtocolDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    // Budget check
    const budgetResult = deps.budgetChecker.check(tenant.id, tenant.spendLimits);
    if (!budgetResult.allowed) {
      const mapped = mapToAnthropicError(429, budgetResult.reason ?? "Budget exceeded");
      return anthropicErrorResponse(mapped.status, mapped.body);
    }

    // Parse Anthropic request
    let anthropicReq: AnthropicRequest;
    try {
      anthropicReq = (await c.req.json()) as AnthropicRequest;
    } catch {
      const mapped = mapToAnthropicError(400, "Invalid JSON in request body");
      return anthropicErrorResponse(mapped.status, mapped.body);
    }

    if (!anthropicReq.model || !anthropicReq.messages || !anthropicReq.max_tokens) {
      const mapped = mapToAnthropicError(400, "Missing required fields: model, messages, max_tokens");
      return anthropicErrorResponse(mapped.status, mapped.body);
    }

    // For now, always route through OpenRouter with format translation.
    // Future: check if Anthropic direct is cheaper and forward as-is.
    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      const mapped = mapToAnthropicError(503, "LLM service not configured");
      return anthropicErrorResponse(mapped.status, mapped.body);
    }

    try {
      // Translate Anthropic -> OpenAI format
      const openaiReq = anthropicToOpenAI(anthropicReq);
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

      // Forward to OpenRouter
      const res = await deps.fetchFn(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(openaiReq),
      });

      if (!res.ok) {
        const errText = await res.text();
        logger.error("Anthropic handler: upstream error", {
          tenant: tenant.id,
          status: res.status,
          error: errText,
        });
        const mapped = mapToAnthropicError(res.status, `Upstream error: ${errText}`);
        return anthropicErrorResponse(mapped.status, mapped.body);
      }

      const openaiRes = (await res.json()) as OpenAIResponse;

      // Translate OpenAI -> Anthropic format
      const anthropicRes = openAIResponseToAnthropic(openaiRes, anthropicReq.model);

      // Meter usage
      const costHeader = res.headers.get("x-openrouter-cost");
      const cost = costHeader ? parseFloat(costHeader) : estimateAnthropicCost(anthropicRes.usage);

      logger.info("Anthropic handler: messages", {
        tenant: tenant.id,
        model: anthropicReq.model,
        inputTokens: anthropicRes.usage.input_tokens,
        outputTokens: anthropicRes.usage.output_tokens,
        cost,
      });

      deps.meter.emit({
        tenant: tenant.id,
        cost,
        charge: deps.withMarginFn(cost, deps.defaultMargin),
        capability: "chat-completions",
        provider: "openrouter",
        timestamp: Date.now(),
      });

      return c.json(anthropicRes);
    } catch (error) {
      logger.error("Anthropic handler: error", { tenant: tenant.id, error });
      const err = error instanceof Error ? error : new Error(String(error));
      const mapped = mapToAnthropicError(500, err.message);
      return anthropicErrorResponse(mapped.status, mapped.body);
    }
  };
}
