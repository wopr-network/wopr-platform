/**
 * Gateway proxy — the core handler that authenticates, budget-checks,
 * proxies to upstream, meters, and responds.
 *
 * Each endpoint handler follows the same pattern:
 * 1. Tenant is already resolved by serviceKeyAuth middleware
 * 2. Budget check via BudgetChecker
 * 3. Forward request to upstream provider
 * 4. Emit meter event
 * 5. Return response to bot
 */

import type { Context } from "hono";
import { z } from "zod";
import { logger } from "../config/logger.js";
import type { TTSOutput } from "../monetization/adapters/types.js";
import { withMargin } from "../monetization/adapters/types.js";
import { NoProviderAvailableError } from "../monetization/arbitrage/types.js";
import type { BudgetChecker } from "../monetization/budget/budget-checker.js";
import { Credit } from "../monetization/credit.js";
import type { CreditLedger } from "../monetization/credits/credit-ledger.js";
import { PHONE_NUMBER_MONTHLY_COST } from "../monetization/credits/phone-billing.js";
import type { MeterEmitter } from "../monetization/metering/emitter.js";
import { creditBalanceCheck, debitCredits } from "./credit-gate.js";
import { mapBudgetError, mapProviderError } from "./error-mapping.js";
import type { SellRateLookupFn } from "./rate-lookup.js";
import { resolveTokenRates } from "./rate-lookup.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";
import { proxySSEStream } from "./streaming.js";
import type { FetchFn, GatewayConfig, ProviderConfig } from "./types.js";

const DEFAULT_MARGIN = 1.3;

/** Max call duration cap: 4 hours = 240 minutes. */
const MAX_CALL_DURATION_MINUTES = 240;

const phoneInboundBodySchema = z.object({
  call_sid: z.string().optional(),
  // Twilio sends all fields as strings in form-encoded bodies; coerce to number.
  duration_minutes: z.coerce.number().min(0).max(MAX_CALL_DURATION_MINUTES).optional(),
  status: z.string().optional(),
});

const smsInboundBodySchema = z.object({
  message_sid: z.string().optional(),
  from: z.string(),
  to: z.string(),
  body: z.string(),
  media_url: z.array(z.string().url()).optional(),
  // Twilio sends numeric fields as strings in form-encoded bodies; coerce to number.
  num_media: z.coerce.number().int().min(0).optional(),
});

const smsDeliveryStatusBodySchema = z.object({
  message_sid: z.string(),
  message_status: z.string(),
  // Twilio sends numeric fields as strings in form-encoded bodies; coerce to number.
  error_code: z.coerce.number().nullable().optional(),
  error_message: z.string().nullable().optional(),
});

/** Shared state for all proxy handlers. */
export interface ProxyDeps {
  meter: MeterEmitter;
  budgetChecker: BudgetChecker;
  creditLedger?: CreditLedger;
  topUpUrl: string;
  graceBufferCents?: number;
  providers: ProviderConfig;
  defaultMargin: number;
  fetchFn: FetchFn;
  arbitrageRouter?: import("../monetization/arbitrage/router.js").ArbitrageRouter;
  rateLookupFn?: SellRateLookupFn;
  metrics?: import("../observability/metrics.js").MetricsCollector;
  /** Base URL for Twilio webhook callbacks (e.g., https://api.wopr.network/v1). Used to construct StatusCallback and TwiML URLs. */
  webhookBaseUrl?: string;
  phoneRepo?: import("../monetization/credits/drizzle-phone-number-repository.js").IPhoneNumberRepository;
  /** Called after every successful credit debit (fire-and-forget auto-topup trigger). */
  onDebitComplete?: (tenantId: string) => void;
  /** Called when a debit causes balance to cross the zero threshold. */
  onBalanceExhausted?: (tenantId: string, newBalanceCents: number) => void;
}

export function buildProxyDeps(config: GatewayConfig): ProxyDeps {
  return {
    meter: config.meter,
    budgetChecker: config.budgetChecker,
    creditLedger: config.creditLedger,
    topUpUrl: config.topUpUrl ?? "/dashboard/credits",
    graceBufferCents: config.graceBufferCents,
    providers: config.providers,
    defaultMargin: config.defaultMargin ?? DEFAULT_MARGIN,
    fetchFn: config.fetchFn ?? fetch,
    arbitrageRouter: config.arbitrageRouter,
    rateLookupFn: config.rateLookupFn,
    metrics: config.metrics,
    webhookBaseUrl: config.webhookBaseUrl,
    phoneRepo: config.phoneRepo,
    onDebitComplete: config.onDebitComplete,
    onBalanceExhausted: config.onBalanceExhausted,
  };
}

/**
 * Run the pre-call budget check. Returns an error response if budget is exceeded.
 */
async function budgetCheck(c: Context<GatewayAuthEnv>, deps: ProxyDeps): Promise<Response | null> {
  const tenant = c.get("gatewayTenant");
  const result = await deps.budgetChecker.check(tenant.id, tenant.spendLimits);

  if (!result.allowed) {
    const mapped = mapBudgetError(result.reason ?? "Budget exceeded");
    return c.json(mapped.body, mapped.status as 402 | 429);
  }

  return null;
}

/**
 * Emit a meter event after a successful proxy call.
 */
function emitMeterEvent(
  deps: ProxyDeps,
  tenantId: string,
  capability: string,
  provider: string,
  cost: Credit,
  margin?: number,
  opts?: {
    usage?: { units: number; unitType: string };
    tier?: "wopr" | "branded" | "byok";
    metadata?: Record<string, unknown>;
  },
): void {
  const charge = withMargin(cost, margin ?? deps.defaultMargin);
  deps.meter.emit({
    tenant: tenantId,
    cost,
    charge,
    capability,
    provider,
    timestamp: Date.now(),
    ...(opts?.usage ? { usage: opts.usage } : {}),
    ...(opts?.tier ? { tier: opts.tier } : {}),
    ...(opts?.metadata ? { metadata: opts.metadata } : {}),
  });
}

// -----------------------------------------------------------------------
// LLM Chat Completions — POST /v1/chat/completions
// -----------------------------------------------------------------------

export function chatCompletions(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for chat completions
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    // Parse body once — needed for both arbitrage routing and direct proxy.
    const body = await c.req.text();
    let isStreaming = false;
    let requestModel: string | undefined;
    let parsedBody:
      | {
          stream?: boolean;
          model?: string;
          messages?: Array<{ role: string; content: string }>;
          max_tokens?: number;
          temperature?: number;
        }
      | undefined;
    try {
      parsedBody = JSON.parse(body) as typeof parsedBody;
      isStreaming = parsedBody?.stream === true;
      requestModel = parsedBody?.model;
    } catch {
      // Not valid JSON, assume non-streaming
    }

    deps.metrics?.recordGatewayRequest("chat-completions");

    // WOP-746: Arbitrage routing for non-streaming chat completions.
    // Mirrors the TTS arbitrage pattern. When arbitrageRouter is present and
    // the request is non-streaming, delegate to the cheapest available provider.
    // Falls back to direct OpenRouter proxy on NoProviderAvailableError.
    if (deps.arbitrageRouter && !isStreaming) {
      try {
        // Extract prompt from messages array for the adapter's TextGenerationInput
        const lastUserMsg = parsedBody?.messages?.filter((m) => m.role === "user").pop();
        const prompt = lastUserMsg?.content ?? "";

        const result = await deps.arbitrageRouter.route<
          import("../monetization/adapters/types.js").TextGenerationOutput
        >({
          capability: "text-generation",
          tenantId: tenant.id,
          input: {
            prompt,
            messages: parsedBody?.messages,
            model: requestModel,
            maxTokens: parsedBody?.max_tokens,
            temperature: parsedBody?.temperature,
          },
          model: requestModel,
        });

        const { text, model: responseModel, usage } = result.result;
        const cost = result.cost;
        const provider = result.provider;
        const totalTokens = usage.inputTokens + usage.outputTokens;

        logger.info("Gateway proxy: chat/completions (arbitrage)", {
          tenant: tenant.id,
          model: responseModel,
          cost,
          provider,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });

        emitMeterEvent(deps, tenant.id, "chat-completions", provider, cost, undefined, {
          usage: { units: totalTokens, unitType: "tokens" },
          tier: "branded",
          metadata: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: responseModel },
        });
        debitCredits(deps, tenant.id, cost.toDollars(), deps.defaultMargin, "chat-completions", provider);

        return c.json(
          {
            id: `chatcmpl-arb-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: responseModel,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: totalTokens,
            },
          },
          200,
        );
      } catch (error) {
        if (error instanceof NoProviderAvailableError) {
          // Fall through to direct OpenRouter proxy below
          logger.info("Gateway proxy: chat/completions arbitrage no provider, falling back to direct proxy", {
            tenant: tenant.id,
          });
        } else {
          deps.metrics?.recordGatewayError("chat-completions");
          logger.error("Gateway proxy error: chat/completions (arbitrage)", { tenant: tenant.id, error });
          const mapped = mapProviderError(error, "arbitrage");
          return c.json(mapped.body, mapped.status as 502);
        }
      }
    }

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "LLM service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

      // body, isStreaming, and requestModel are parsed above before the arbitrage block.

      const res = await deps.fetchFn(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      // If streaming, pipe SSE through without buffering
      if (isStreaming && res.ok) {
        return proxySSEStream(res, {
          tenant,
          deps,
          capability: "chat-completions",
          provider: "openrouter",
          costHeader: res.headers.get("x-openrouter-cost"),
          model: requestModel,
          rateLookupFn: deps.rateLookupFn,
        });
      }

      const responseBody = await res.text();
      const costHeader = res.headers.get("x-openrouter-cost");
      const cost = costHeader
        ? parseFloat(costHeader)
        : await estimateTokenCost(responseBody, requestModel, deps.rateLookupFn);

      logger.info("Gateway proxy: chat/completions", {
        tenant: tenant.id,
        status: res.status,
        cost,
      });

      if (res.ok) {
        // Parse token counts and model from response (WOP-512)
        let usage: { units: number; unitType: string } | undefined;
        let metadata: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(responseBody) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
          };
          const inputTokens = parsed.usage?.prompt_tokens ?? 0;
          const outputTokens = parsed.usage?.completion_tokens ?? 0;
          const totalTokens = parsed.usage?.total_tokens ?? inputTokens + outputTokens;
          if (totalTokens > 0) {
            usage = { units: totalTokens, unitType: "tokens" };
            metadata = { inputTokens, outputTokens, model: parsed.model };
          }
        } catch {
          // If parsing fails, proceed without usage data
        }
        emitMeterEvent(deps, tenant.id, "chat-completions", "openrouter", Credit.fromDollars(cost), undefined, {
          usage,
          tier: "branded",
          metadata,
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "chat-completions", "openrouter");
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("chat-completions");
      logger.error("Gateway proxy error: chat/completions", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "openrouter");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// LLM Text Completions — POST /v1/completions
// -----------------------------------------------------------------------

export function textCompletions(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for text completions
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "LLM service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("text-completions");
      const body = await c.req.text();
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

      let requestModel: string | undefined;
      try {
        const parsed = JSON.parse(body) as { model?: string };
        requestModel = parsed.model;
      } catch {
        // ignore parse errors
      }

      const res = await deps.fetchFn(`${baseUrl}/v1/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      const responseBody = await res.text();
      const costHeader = res.headers.get("x-openrouter-cost");
      const cost = costHeader
        ? parseFloat(costHeader)
        : await estimateTokenCost(responseBody, requestModel, deps.rateLookupFn, "text-completions");

      logger.info("Gateway proxy: completions", { tenant: tenant.id, status: res.status, cost });

      if (res.ok) {
        // Parse token counts and model from response (WOP-512)
        let usage: { units: number; unitType: string } | undefined;
        let metadata: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(responseBody) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
          };
          const inputTokens = parsed.usage?.prompt_tokens ?? 0;
          const outputTokens = parsed.usage?.completion_tokens ?? 0;
          const totalTokens = parsed.usage?.total_tokens ?? inputTokens + outputTokens;
          if (totalTokens > 0) {
            usage = { units: totalTokens, unitType: "tokens" };
            metadata = { inputTokens, outputTokens, model: parsed.model };
          }
        } catch {
          // If parsing fails, proceed without usage data
        }
        emitMeterEvent(deps, tenant.id, "text-completions", "openrouter", Credit.fromDollars(cost), undefined, {
          usage,
          tier: "branded",
          metadata,
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "text-completions", "openrouter");
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("text-completions");
      logger.error("Gateway proxy error: completions", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "openrouter");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Embeddings — POST /v1/embeddings
// -----------------------------------------------------------------------

export function embeddings(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for embeddings
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "Embeddings service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("embeddings");
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
      const cost = costHeader ? parseFloat(costHeader) : 0.0001; // flat fallback for embeddings

      logger.info("Gateway proxy: embeddings", { tenant: tenant.id, status: res.status, cost });

      if (res.ok) {
        // Parse token counts from response (WOP-512)
        let usage: { units: number; unitType: string } | undefined;
        let metadata: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(responseBody) as {
            usage?: { total_tokens?: number };
            model?: string;
          };
          const totalTokens = parsed.usage?.total_tokens ?? 0;
          if (totalTokens > 0) {
            usage = { units: totalTokens, unitType: "tokens" };
            metadata = { model: parsed.model };
          }
        } catch {
          // If parsing fails, proceed without usage data
        }
        emitMeterEvent(deps, tenant.id, "embeddings", "openrouter", Credit.fromDollars(cost), undefined, {
          usage,
          tier: "branded",
          metadata,
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "embeddings", "openrouter");
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("embeddings");
      logger.error("Gateway proxy error: embeddings", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "openrouter");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// STT — POST /v1/audio/transcriptions
// -----------------------------------------------------------------------

export function audioTranscriptions(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for STT
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const providerCfg = deps.providers.deepgram;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "STT service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("transcription");
      const audioBody = await c.req.arrayBuffer();
      const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
      const model = c.req.query("model") ?? "nova-2";
      const language = c.req.query("language");
      const baseUrl = providerCfg.baseUrl ?? "https://api.deepgram.com";

      const params = new URLSearchParams({ model });
      if (language) {
        params.set("language", language);
      } else {
        params.set("detect_language", "true");
      }

      const res = await deps.fetchFn(`${baseUrl}/v1/listen?${params.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${providerCfg.apiKey}`,
          "Content-Type": contentType,
        },
        body: audioBody,
      });

      const responseBody = await res.text();

      // Estimate cost from audio duration in response
      let cost = 0.001; // minimum fallback
      let durationSeconds = 0;
      try {
        const parsed = JSON.parse(responseBody) as { metadata?: { duration?: number } };
        if (parsed.metadata?.duration) {
          durationSeconds = parsed.metadata.duration;
          cost = (durationSeconds / 60) * 0.0043; // Nova-2 wholesale rate
        }
      } catch {
        // use fallback cost
      }

      logger.info("Gateway proxy: audio/transcriptions", {
        tenant: tenant.id,
        status: res.status,
        cost,
      });

      if (res.ok) {
        emitMeterEvent(deps, tenant.id, "transcription", "deepgram", Credit.fromDollars(cost), undefined, {
          usage: durationSeconds > 0 ? { units: durationSeconds / 60, unitType: "minutes" } : undefined,
          tier: "branded",
          metadata: durationSeconds > 0 ? { model, durationSeconds } : undefined,
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "transcription", "deepgram");
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("transcription");
      logger.error("Gateway proxy error: audio/transcriptions", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "deepgram");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// TTS — POST /v1/audio/speech
// -----------------------------------------------------------------------

export function audioSpeech(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for TTS
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    // Parse body once — reused by both the arbitrage path and the ElevenLabs fallback.
    let body: { input?: string; voice?: string; model?: string; response_format?: string };
    try {
      body = await c.req.json<{
        input?: string;
        voice?: string;
        model?: string;
        response_format?: string;
      }>();
    } catch {
      return c.json(
        {
          error: {
            message: "Invalid JSON in request body",
            type: "invalid_request_error",
            code: "parse_error",
          },
        },
        400,
      );
    }

    deps.metrics?.recordGatewayRequest("tts");

    // WOP-463: If arbitrage router is available, delegate routing to it (non-streaming only)
    if (deps.arbitrageRouter) {
      try {
        const text = body.input ?? "";
        const voice = body.voice ?? "21m00Tcm4TlvDq8ikWAM";
        const format = body.response_format ?? "mp3";

        const result = await deps.arbitrageRouter.route<TTSOutput>({
          capability: "tts",
          tenantId: tenant.id,
          input: { text, voice, format },
        });

        const characterCount = text.length;
        const cost = result.cost;
        const provider = result.provider;

        logger.info("Gateway proxy: audio/speech (arbitrage)", {
          tenant: tenant.id,
          characters: characterCount,
          cost,
          provider,
        });
        emitMeterEvent(deps, tenant.id, "tts", provider, cost, undefined, {
          usage: { units: characterCount, unitType: "characters" },
          tier: "branded",
        });
        debitCredits(deps, tenant.id, cost.toDollars(), deps.defaultMargin, "tts", provider);

        const { audioUrl, format: audioFormat } = result.result;
        // audioUrl may be a data URL (data:<mime>;base64,<data>) or a remote URL.
        if (audioUrl.startsWith("data:")) {
          const [header, b64] = audioUrl.split(",", 2);
          const mimeType = header.split(";")[0].slice(5);
          const audioBuffer = Buffer.from(b64 ?? "", "base64");
          return new Response(audioBuffer, {
            status: 200,
            headers: { "Content-Type": mimeType || `audio/${audioFormat}` },
          });
        }
        // Remote URL — fetch and forward.
        const audioRes = await deps.fetchFn(audioUrl);
        return new Response(audioRes.body, {
          status: 200,
          headers: {
            "Content-Type": audioRes.headers.get("Content-Type") ?? `audio/${audioFormat}`,
          },
        });
      } catch (error) {
        if (error instanceof NoProviderAvailableError) {
          deps.metrics?.recordGatewayError("tts");
          return c.json(
            {
              error: {
                message: error.message,
                type: "server_error",
                code: "no_provider_available",
              },
            },
            503,
          );
        }
        deps.metrics?.recordGatewayError("tts");
        logger.error("Gateway proxy error: audio/speech (arbitrage)", { tenant: tenant.id, error });
        const mapped = mapProviderError(error, "arbitrage");
        return c.json(mapped.body, mapped.status as 502);
      }
    }

    const providerCfg = deps.providers.elevenlabs;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "TTS service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const text = body.input ?? "";
      const voice = body.voice ?? "21m00Tcm4TlvDq8ikWAM";
      const format = body.response_format ?? "mp3";
      const baseUrl = providerCfg.baseUrl ?? "https://api.elevenlabs.io";

      // ElevenLabs output_format: mp3 needs sample rate/bitrate suffix, others use format directly
      const outputFormat = format === "mp3" ? "mp3_44100_128" : format;

      const res = await deps.fetchFn(`${baseUrl}/v1/text-to-speech/${voice}?output_format=${outputFormat}`, {
        method: "POST",
        headers: {
          "xi-api-key": providerCfg.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: body.model ?? "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw Object.assign(new Error(`ElevenLabs API error (${res.status}): ${errText}`), {
          httpStatus: res.status,
        });
      }

      // Cost = per character
      const characterCount = text.length;
      const cost = characterCount * 0.000015; // wholesale rate

      logger.info("Gateway proxy: audio/speech", {
        tenant: tenant.id,
        characters: characterCount,
        cost,
      });
      emitMeterEvent(deps, tenant.id, "tts", "elevenlabs", Credit.fromDollars(cost), undefined, {
        usage: { units: characterCount, unitType: "characters" },
        tier: "branded",
        metadata: { voice, model: body.model ?? "eleven_multilingual_v2" },
      });
      debitCredits(deps, tenant.id, cost, deps.defaultMargin, "tts", "elevenlabs");

      const audioBuffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "audio/mpeg";

      return new Response(audioBuffer, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("tts");
      logger.error("Gateway proxy error: audio/speech", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "elevenlabs");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Image Generation — POST /v1/images/generations
// -----------------------------------------------------------------------

export function imageGenerations(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for image generation
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const providerCfg = deps.providers.replicate;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "Image service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("image-generation");
      const body = await c.req.json<{ prompt?: string; n?: number; size?: string }>();
      const baseUrl = providerCfg.baseUrl ?? "https://api.replicate.com";

      // Parse size into width/height
      let width = 1024;
      let height = 1024;
      if (body.size) {
        const [w, h] = body.size.split("x").map(Number);
        if (w && h) {
          width = w;
          height = h;
        }
      }

      const res = await deps.fetchFn(`${baseUrl}/v1/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiToken}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          version: "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
          input: {
            prompt: body.prompt ?? "",
            width,
            height,
            num_outputs: body.n ?? 1,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw Object.assign(new Error(`Replicate API error (${res.status}): ${errText}`), {
          httpStatus: res.status,
        });
      }

      const prediction = (await res.json()) as {
        output?: string[];
        metrics?: { predict_time?: number };
      };
      const predictTime = prediction.metrics?.predict_time ?? 5;
      const cost = predictTime * 0.0023; // SDXL wholesale rate

      logger.info("Gateway proxy: images/generations", { tenant: tenant.id, cost });
      emitMeterEvent(deps, tenant.id, "image-generation", "replicate", Credit.fromDollars(cost), undefined, {
        usage: { units: body.n ?? 1, unitType: "images" },
        tier: "branded",
        metadata: { width, height, predictTimeSeconds: predictTime },
      });
      debitCredits(deps, tenant.id, cost, deps.defaultMargin, "image-generation", "replicate");

      // Return in OpenAI-compatible format
      const images = Array.isArray(prediction.output) ? prediction.output : [];
      return c.json({
        created: Math.floor(Date.now() / 1000),
        data: images.map((url) => ({ url })),
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("image-generation");
      logger.error("Gateway proxy error: images/generations", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "replicate");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Video Generation — POST /v1/video/generations
// -----------------------------------------------------------------------

export function videoGenerations(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for image generation
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const providerCfg = deps.providers.replicate;
    if (!providerCfg) {
      return c.json(
        {
          error: {
            message: "Video service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("video-generation");
      const body = await c.req.json<{ prompt?: string; duration?: number }>();
      const baseUrl = providerCfg.baseUrl ?? "https://api.replicate.com";

      const res = await deps.fetchFn(`${baseUrl}/v1/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiToken}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          version: "video-generation-model",
          input: {
            prompt: body.prompt ?? "",
            duration: body.duration ?? 4,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw Object.assign(new Error(`Replicate API error (${res.status}): ${errText}`), {
          httpStatus: res.status,
        });
      }

      const prediction = (await res.json()) as {
        output?: string;
        metrics?: { predict_time?: number };
      };
      const predictTime = prediction.metrics?.predict_time ?? 30;
      const cost = predictTime * 0.005; // video gen wholesale rate

      logger.info("Gateway proxy: video/generations", { tenant: tenant.id, cost });
      emitMeterEvent(deps, tenant.id, "video-generation", "replicate", Credit.fromDollars(cost), undefined, {
        usage: { units: body.duration ?? 4, unitType: "seconds" },
        tier: "branded",
        metadata: { predictTimeSeconds: predictTime },
      });
      debitCredits(deps, tenant.id, cost, deps.defaultMargin, "video-generation", "replicate");

      return c.json({
        created: Math.floor(Date.now() / 1000),
        data: [{ url: prediction.output ?? "" }],
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("video-generation");
      logger.error("Gateway proxy error: video/generations", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "replicate");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone Outbound — POST /v1/phone/outbound
// -----------------------------------------------------------------------

export function phoneOutbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        {
          error: {
            message: "Phone service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    let body: { to: string; from: string; twiml?: string };
    try {
      body = await c.req.json<{ to: string; from: string; twiml?: string }>();
    } catch {
      return c.json(
        {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
            code: "bad_request",
          },
        },
        400,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("phone-outbound");

      if (!body.to || !body.from) {
        return c.json(
          {
            error: {
              message: "Missing required fields: to, from",
              type: "invalid_request_error",
              code: "missing_field",
            },
          },
          400,
        );
      }

      const baseUrl = twilioCfg.baseUrl ?? "https://api.twilio.com";
      const twilioUrl = `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/Calls.json`;

      // Self-hosted TwiML fallback — avoids plain-HTTP third-party URLs (Twilio rejects HTTP in production).
      const webhookBase = deps.webhookBaseUrl?.replace(/\/$/, "") ?? "";

      const params = new URLSearchParams();
      params.set("To", body.to);
      params.set("From", body.from);
      // Use caller-provided TwiML URL if given; otherwise use self-hosted HTTPS endpoint.
      // Omitting Url entirely when no webhookBase is set — Twilio's own default is a hangup.
      const twimlUrl = body.twiml ?? (webhookBase ? `${webhookBase}/phone/twiml/hangup` : undefined);
      if (twimlUrl) {
        params.set("Url", twimlUrl);
      }
      // Bill based on actual call duration reported by Twilio StatusCallback,
      // matching the inbound pattern. Without this, short/failed calls are over-billed
      // and long calls are under-billed.
      if (webhookBase) {
        params.set("StatusCallback", `${webhookBase}/phone/outbound/status/${tenant.id}`);
        params.set("StatusCallbackMethod", "POST");
        params.set("StatusCallbackEvent", "completed");
      }

      const authHeader = `Basic ${btoa(`${twilioCfg.accountSid}:${twilioCfg.authToken}`)}`;

      const res = await deps.fetchFn(twilioUrl, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      const responseBody = await res.text();

      if (!res.ok) {
        throw Object.assign(new Error(`Twilio API error (${res.status}): ${responseBody}`), {
          httpStatus: res.status,
        });
      }

      const twilioCall = JSON.parse(responseBody) as {
        sid?: string;
        status?: string;
        error_code?: number | null;
        error_message?: string | null;
      };

      logger.info("Gateway proxy: phone/outbound", {
        tenant: tenant.id,
        sid: twilioCall.sid,
        status: twilioCall.status,
      });

      // When webhookBaseUrl is configured, billing is deferred to the StatusCallback
      // (phoneOutboundStatus) so we meter actual call duration instead of a flat 1 minute.
      // Without webhookBaseUrl (e.g., local dev), bill 1 minute as a conservative estimate.
      if (!webhookBase) {
        const cost = 0.013; // 1 minute at wholesale rate
        emitMeterEvent(deps, tenant.id, "phone-outbound", "twilio", Credit.fromDollars(cost), deps.defaultMargin, {
          usage: { units: 1, unitType: "minutes" },
          tier: "branded",
        });
        debitCredits(deps, tenant.id, cost, deps.defaultMargin, "phone-outbound", "twilio");
      }

      return c.json({
        sid: twilioCall.sid,
        status: twilioCall.status,
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("phone-outbound");
      logger.error("Gateway proxy error: phone/outbound", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone Inbound — POST /v1/phone/inbound (webhook from Twilio/Telnyx)
// -----------------------------------------------------------------------

export function phoneInbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const providerName = deps.providers.twilio ? "twilio" : "telnyx";

    try {
      deps.metrics?.recordGatewayRequest("phone-inbound");
      // Prefer body parsed by webhook-auth middleware (avoids re-reading the consumed stream).
      // Fall back to c.req.json() only when called without the auth middleware (e.g., tests).
      const rawBody = c.get("webhookBody") ?? (await c.req.json());
      const parsed = phoneInboundBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        logger.warn("Gateway proxy: phone/inbound invalid body", {
          tenant: tenant.id,
          errors: parsed.error.flatten().fieldErrors,
        });
        return c.json(
          {
            error: {
              message: "Invalid webhook payload",
              type: "invalid_request_error",
              code: "validation_error",
            },
          },
          400,
        );
      }
      const body = parsed.data;

      // Meter per-minute events for active calls
      const durationMinutes = body.duration_minutes ?? 1;
      const costPerMinute = 0.013; // wholesale per-minute rate
      const cost = durationMinutes * costPerMinute;

      logger.info("Gateway proxy: phone/inbound", {
        tenant: tenant.id,
        durationMinutes,
        cost,
        status: body.status,
      });

      emitMeterEvent(deps, tenant.id, "phone-inbound", providerName, Credit.fromDollars(cost), undefined, {
        usage: { units: durationMinutes, unitType: "minutes" },
        tier: "branded",
      });
      debitCredits(deps, tenant.id, cost, deps.defaultMargin, "phone-inbound", providerName);

      return c.json({ status: "metered", duration_minutes: durationMinutes });
    } catch (error) {
      deps.metrics?.recordGatewayError("phone-inbound");
      logger.error("Gateway proxy error: phone/inbound", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, providerName);
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone Outbound Status — POST /v1/phone/outbound/status/:tenantId (Twilio StatusCallback)
// -----------------------------------------------------------------------

const phoneOutboundStatusBodySchema = z.object({
  CallSid: z.string().optional(),
  // Twilio sends CallDuration in seconds as a string in form-encoded bodies; coerce to number.
  CallDuration: z.coerce
    .number()
    .min(0)
    .max(MAX_CALL_DURATION_MINUTES * 60)
    .optional(),
  CallStatus: z.string().optional(),
});

export function phoneOutboundStatus(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const providerName = "twilio";

    try {
      deps.metrics?.recordGatewayRequest("phone-outbound");
      const rawBody = c.get("webhookBody") ?? (await c.req.json());
      const parsed = phoneOutboundStatusBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        logger.warn("Gateway proxy: phone/outbound/status invalid body", {
          tenant: tenant.id,
          errors: parsed.error.flatten().fieldErrors,
        });
        return c.json(
          {
            error: {
              message: "Invalid webhook payload",
              type: "invalid_request_error",
              code: "validation_error",
            },
          },
          400,
        );
      }
      const body = parsed.data;

      // Only meter completed calls that actually connected (have a duration).
      // Calls that fail before connecting have CallDuration = 0 or absent.
      const durationSeconds = body.CallDuration ?? 0;
      const durationMinutes = Math.ceil(durationSeconds / 60);

      if (durationMinutes === 0) {
        // Call failed before connecting — no charge.
        logger.info("Gateway proxy: phone/outbound/status no-charge (call did not connect)", {
          tenant: tenant.id,
          sid: body.CallSid,
          status: body.CallStatus,
        });
        return c.json({ status: "no-charge" });
      }

      const costPerMinute = 0.013; // wholesale per-minute rate
      const cost = durationMinutes * costPerMinute;

      logger.info("Gateway proxy: phone/outbound/status", {
        tenant: tenant.id,
        sid: body.CallSid,
        durationMinutes,
        cost,
        status: body.CallStatus,
      });

      emitMeterEvent(deps, tenant.id, "phone-outbound", providerName, Credit.fromDollars(cost), deps.defaultMargin, {
        usage: { units: durationMinutes, unitType: "minutes" },
        tier: "branded",
      });
      debitCredits(deps, tenant.id, cost, deps.defaultMargin, "phone-outbound", providerName);

      return c.json({ status: "metered", duration_minutes: durationMinutes });
    } catch (error) {
      deps.metrics?.recordGatewayError("phone-outbound");
      logger.error("Gateway proxy error: phone/outbound/status", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, providerName);
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone TwiML Hangup — GET /v1/phone/twiml/hangup (self-hosted TwiML)
// -----------------------------------------------------------------------

export function phoneTwimlHangup() {
  return (_c: Context) => {
    return new Response("<Response><Hangup/></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  };
}

// -----------------------------------------------------------------------
// SMS Outbound — POST /v1/messages/sms
// -----------------------------------------------------------------------

/** Wholesale per-message costs (USD). */
const SMS_WHOLESALE_COST = 0.0079;
const MMS_WHOLESALE_COST = 0.02;

/** SMS outbound margin (retail / wholesale). ~2.5x markup. */
const SMS_OUTBOUND_MARGIN = 2.53;
const MMS_OUTBOUND_MARGIN = 2.5;

export function smsOutbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for SMS/MMS
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        {
          error: {
            message: "SMS service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      deps.metrics?.recordGatewayRequest("sms-outbound");
      const body = await c.req.json<{
        to: string;
        body: string;
        from: string;
        media_url?: string[];
      }>();

      if (!body.to || !body.body || !body.from) {
        return c.json(
          {
            error: {
              message: "Missing required fields: to, body, from",
              type: "invalid_request_error",
              code: "missing_field",
            },
          },
          400,
        );
      }

      const isMMS = body.media_url && body.media_url.length > 0;
      const capability = isMMS ? "mms-outbound" : "sms-outbound";

      // Build Twilio Messages API request (form-encoded)
      const baseUrl = twilioCfg.baseUrl ?? "https://api.twilio.com";
      const twilioUrl = `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/Messages.json`;

      const params = new URLSearchParams();
      params.set("To", body.to);
      params.set("Body", body.body);
      params.set("From", body.from);

      // Attach media URLs for MMS
      if (body.media_url) {
        for (const url of body.media_url) {
          params.append("MediaUrl", url);
        }
      }

      const authHeader = `Basic ${btoa(`${twilioCfg.accountSid}:${twilioCfg.authToken}`)}`;

      const res = await deps.fetchFn(twilioUrl, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      const responseBody = await res.text();

      if (!res.ok) {
        throw Object.assign(new Error(`Twilio API error (${res.status}): ${responseBody}`), {
          httpStatus: res.status,
        });
      }

      const twilioMsg = JSON.parse(responseBody) as {
        sid?: string;
        status?: string;
        error_code?: number | null;
        error_message?: string | null;
      };

      // Meter the message
      const cost = isMMS ? MMS_WHOLESALE_COST : SMS_WHOLESALE_COST;
      const margin = isMMS ? MMS_OUTBOUND_MARGIN : SMS_OUTBOUND_MARGIN;

      logger.info("Gateway proxy: messages/sms", {
        tenant: tenant.id,
        capability,
        to: body.to,
        sid: twilioMsg.sid,
        status: twilioMsg.status,
        cost,
      });

      emitMeterEvent(deps, tenant.id, capability, "twilio", Credit.fromDollars(cost), margin, {
        usage: { units: 1, unitType: "messages" },
        tier: "branded",
      });
      debitCredits(deps, tenant.id, cost, margin, capability, "twilio");

      return c.json({
        sid: twilioMsg.sid,
        status: twilioMsg.status ?? "queued",
        capability,
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("sms-outbound");
      logger.error("Gateway proxy error: messages/sms", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// SMS Inbound — POST /v1/messages/sms/inbound (webhook from Twilio/Telnyx)
// -----------------------------------------------------------------------

/** Inbound SMS margin (~1.3x markup). */
const SMS_INBOUND_MARGIN = 1.27;
const MMS_INBOUND_MARGIN = 1.25;

export function smsInbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    try {
      deps.metrics?.recordGatewayRequest("sms-inbound");
      // Prefer body parsed by webhook-auth middleware (avoids re-reading the consumed stream).
      // Fall back to c.req.json() only when called without the auth middleware (e.g., tests).
      const rawBody = c.get("webhookBody") ?? (await c.req.json());
      const parsed = smsInboundBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        logger.warn("Gateway proxy: messages/sms/inbound invalid body", {
          tenant: tenant.id,
          errors: parsed.error.flatten().fieldErrors,
        });
        return c.json(
          {
            error: {
              message: "Invalid webhook payload",
              type: "invalid_request_error",
              code: "validation_error",
            },
          },
          400,
        );
      }
      const body = parsed.data;

      const isMMS = (body.media_url && body.media_url.length > 0) || (body.num_media && body.num_media > 0);
      const capability = isMMS ? "mms-inbound" : "sms-inbound";
      const cost = isMMS ? MMS_WHOLESALE_COST : SMS_WHOLESALE_COST;
      const margin = isMMS ? MMS_INBOUND_MARGIN : SMS_INBOUND_MARGIN;

      logger.info("Gateway proxy: messages/sms/inbound", {
        tenant: tenant.id,
        capability,
        from: body.from,
        sid: body.message_sid,
      });

      emitMeterEvent(deps, tenant.id, capability, "twilio", Credit.fromDollars(cost), margin, {
        usage: { units: 1, unitType: "messages" },
        tier: "branded",
      });
      debitCredits(deps, tenant.id, cost, margin, capability, "twilio");

      return c.json({
        status: "received",
        capability,
        message_sid: body.message_sid ?? null,
      });
    } catch (error) {
      deps.metrics?.recordGatewayError("sms-inbound");
      logger.error("Gateway proxy error: messages/sms/inbound", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// SMS Delivery Status — POST /v1/messages/sms/status (Twilio status callback)
// -----------------------------------------------------------------------

export function smsDeliveryStatus(_deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    try {
      // Prefer body parsed by webhook-auth middleware (avoids re-reading the consumed stream).
      // Fall back to c.req.json() only when called without the auth middleware (e.g., tests).
      const rawBody = c.get("webhookBody") ?? (await c.req.json());
      const parsed = smsDeliveryStatusBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        logger.warn("Gateway proxy: messages/sms/status invalid body", {
          tenant: tenant.id,
          errors: parsed.error.flatten().fieldErrors,
        });
        return c.json(
          {
            error: {
              message: "Invalid webhook payload",
              type: "invalid_request_error",
              code: "validation_error",
            },
          },
          400,
        );
      }
      const body = parsed.data;

      logger.info("Gateway proxy: messages/sms/status", {
        tenant: tenant.id,
        sid: body.message_sid,
        status: body.message_status,
        errorCode: body.error_code,
      });

      return c.json({
        status: "acknowledged",
        message_sid: body.message_sid,
        message_status: body.message_status,
      });
    } catch (error) {
      logger.error("Gateway proxy error: messages/sms/status", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone Number Provisioning — POST /v1/phone/numbers
// -----------------------------------------------------------------------

const PHONE_NUMBER_MARGIN = 2.6;

/** Prefix used in Twilio FriendlyName to track tenant ownership. */
const TENANT_NUMBER_PREFIX = "wopr:tenant:";

export function phoneNumberProvision(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = await budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    // Estimate minimum 1 cent for phone number provision
    const creditErr = await creditBalanceCheck(c, deps, 1);
    if (creditErr) {
      return c.json({ error: creditErr }, 402);
    }

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        {
          error: {
            message: "Phone service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const body = await c.req.json<{
        area_code?: string;
        country?: string;
        capabilities?: { sms?: boolean; voice?: boolean; mms?: boolean };
      }>();

      const baseUrl = twilioCfg.baseUrl ?? "https://api.twilio.com";
      const authHeader = `Basic ${btoa(`${twilioCfg.accountSid}:${twilioCfg.authToken}`)}`;
      const country = body.country ?? "US";

      // Step 1: Search for available numbers
      const searchParams = new URLSearchParams();
      if (body.area_code) searchParams.set("AreaCode", body.area_code);
      searchParams.set("SmsEnabled", "true");
      searchParams.set("VoiceEnabled", String(body.capabilities?.voice ?? true));
      searchParams.set("MmsEnabled", String(body.capabilities?.mms ?? true));
      searchParams.set("PageSize", "1");

      const searchRes = await deps.fetchFn(
        `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/AvailablePhoneNumbers/${country}/Local.json?${searchParams.toString()}`,
        {
          method: "GET",
          headers: { Authorization: authHeader },
        },
      );

      if (!searchRes.ok) {
        const errText = await searchRes.text();
        throw Object.assign(new Error(`Twilio search error (${searchRes.status}): ${errText}`), {
          httpStatus: searchRes.status,
        });
      }

      const searchBody = (await searchRes.json()) as {
        available_phone_numbers?: Array<{
          phone_number: string;
          friendly_name: string;
          capabilities: { sms: boolean; voice: boolean; mms: boolean };
        }>;
      };

      if (!searchBody.available_phone_numbers?.length) {
        return c.json(
          {
            error: {
              message: "No phone numbers available for the requested criteria",
              type: "not_found_error",
              code: "no_numbers_available",
            },
          },
          404,
        );
      }

      const selectedNumber = searchBody.available_phone_numbers[0];

      // Step 2: Purchase the number (tag with tenant ownership via FriendlyName)
      const purchaseParams = new URLSearchParams();
      purchaseParams.set("PhoneNumber", selectedNumber.phone_number);
      purchaseParams.set("FriendlyName", `${TENANT_NUMBER_PREFIX}${tenant.id}`);

      const purchaseRes = await deps.fetchFn(
        `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/IncomingPhoneNumbers.json`,
        {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: purchaseParams.toString(),
        },
      );

      if (!purchaseRes.ok) {
        const errText = await purchaseRes.text();
        throw Object.assign(new Error(`Twilio purchase error (${purchaseRes.status}): ${errText}`), {
          httpStatus: purchaseRes.status,
        });
      }

      const purchased = (await purchaseRes.json()) as {
        sid: string;
        phone_number: string;
        friendly_name: string;
        capabilities: { sms: boolean; voice: boolean; mms: boolean };
      };

      // Meter the initial phone number cost and track for monthly billing
      emitMeterEvent(
        deps,
        tenant.id,
        "phone-number-provision",
        "twilio",
        Credit.fromDollars(PHONE_NUMBER_MONTHLY_COST),
        PHONE_NUMBER_MARGIN,
        {
          usage: { units: 1, unitType: "numbers" },
          tier: "branded",
        },
      );
      debitCredits(deps, tenant.id, PHONE_NUMBER_MONTHLY_COST, PHONE_NUMBER_MARGIN, "phone-number-provision", "twilio");

      // Track for monthly recurring billing (WOP-964)
      if (deps.phoneRepo) {
        deps.phoneRepo.trackPhoneNumber(tenant.id, purchased.sid, purchased.phone_number).catch((err) => {
          logger.warn("Failed to track phone number for monthly billing", { sid: purchased.sid, err });
        });
      }

      logger.info("Gateway proxy: phone/numbers provisioned", {
        tenant: tenant.id,
        sid: purchased.sid,
        number: purchased.phone_number,
      });

      return c.json({
        id: purchased.sid,
        phone_number: purchased.phone_number,
        friendly_name: purchased.friendly_name,
        capabilities: purchased.capabilities,
      });
    } catch (error) {
      logger.error("Gateway proxy error: phone/numbers provision", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone Number List — GET /v1/phone/numbers
// -----------------------------------------------------------------------

export function phoneNumberList(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        {
          error: {
            message: "Phone service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const baseUrl = twilioCfg.baseUrl ?? "https://api.twilio.com";
      const authHeader = `Basic ${btoa(`${twilioCfg.accountSid}:${twilioCfg.authToken}`)}`;

      // Filter by tenant ownership using FriendlyName prefix
      const friendlyNameFilter = `${TENANT_NUMBER_PREFIX}${tenant.id}`;
      const listParams = new URLSearchParams();
      listParams.set("FriendlyName", friendlyNameFilter);

      const res = await deps.fetchFn(
        `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/IncomingPhoneNumbers.json?${listParams.toString()}`,
        {
          method: "GET",
          headers: { Authorization: authHeader },
        },
      );

      if (!res.ok) {
        const errText = await res.text();
        throw Object.assign(new Error(`Twilio API error (${res.status}): ${errText}`), {
          httpStatus: res.status,
        });
      }

      const twilioBody = (await res.json()) as {
        incoming_phone_numbers?: Array<{
          sid: string;
          phone_number: string;
          friendly_name: string;
          capabilities: { sms: boolean; voice: boolean; mms: boolean };
        }>;
      };

      const numbers = (twilioBody.incoming_phone_numbers ?? []).map((n) => ({
        id: n.sid,
        phone_number: n.phone_number,
        friendly_name: n.friendly_name,
        capabilities: n.capabilities,
      }));

      return c.json({ data: numbers });
    } catch (error) {
      logger.error("Gateway proxy error: phone/numbers list", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Phone Number Release — DELETE /v1/phone/numbers/:id
// -----------------------------------------------------------------------

export function phoneNumberRelease(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        {
          error: {
            message: "Phone service not configured",
            type: "server_error",
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    try {
      const numberId = c.req.param("id");
      if (!numberId) {
        return c.json(
          {
            error: {
              message: "Missing phone number ID",
              type: "invalid_request_error",
              code: "missing_field",
            },
          },
          400,
        );
      }

      const baseUrl = twilioCfg.baseUrl ?? "https://api.twilio.com";
      const authHeader = `Basic ${btoa(`${twilioCfg.accountSid}:${twilioCfg.authToken}`)}`;

      // Verify tenant ownership before deleting
      const verifyRes = await deps.fetchFn(
        `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/IncomingPhoneNumbers/${numberId}.json`,
        {
          method: "GET",
          headers: { Authorization: authHeader },
        },
      );

      if (!verifyRes.ok) {
        const errText = await verifyRes.text();
        throw Object.assign(new Error(`Twilio API error (${verifyRes.status}): ${errText}`), {
          httpStatus: verifyRes.status,
        });
      }

      const numberInfo = (await verifyRes.json()) as { friendly_name?: string };
      const expectedName = `${TENANT_NUMBER_PREFIX}${tenant.id}`;

      if (numberInfo.friendly_name !== expectedName) {
        return c.json(
          {
            error: {
              message: "Phone number not found",
              type: "not_found_error",
              code: "number_not_found",
            },
          },
          404,
        );
      }

      const res = await deps.fetchFn(
        `${baseUrl}/2010-04-01/Accounts/${twilioCfg.accountSid}/IncomingPhoneNumbers/${numberId}.json`,
        {
          method: "DELETE",
          headers: { Authorization: authHeader },
        },
      );

      if (!res.ok) {
        const errText = await res.text();
        throw Object.assign(new Error(`Twilio API error (${res.status}): ${errText}`), {
          httpStatus: res.status,
        });
      }

      // Remove from tracking (WOP-964)
      if (deps.phoneRepo) {
        deps.phoneRepo.removePhoneNumber(numberId).catch((err) => {
          logger.warn("Failed to remove phone number from tracking", { numberId, err });
        });
      }

      logger.info("Gateway proxy: phone/numbers released", {
        tenant: tenant.id,
        numberId,
      });

      return c.json({ status: "released", id: numberId });
    } catch (error) {
      logger.error("Gateway proxy error: phone/numbers release", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, "twilio");
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Estimate token cost from an OpenAI-compatible response body. */
async function estimateTokenCost(
  responseBody: string,
  model?: string,
  rateLookupFn?: SellRateLookupFn,
  capability = "chat-completions",
): Promise<number> {
  try {
    const parsed = JSON.parse(responseBody) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const inputTokens = parsed.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed.usage?.completion_tokens ?? 0;
    if (!rateLookupFn) {
      logger.warn("estimateTokenCost: no rateLookupFn provided — token cost will use default fallback rates", {
        model: model ?? "unknown",
        capability,
        inputTokens,
        outputTokens,
      });
    }
    const rates = await resolveTokenRates(rateLookupFn ?? (() => Promise.resolve(null)), capability, model);
    return (inputTokens * rates.inputRatePer1K + outputTokens * rates.outputRatePer1K) / 1000;
  } catch {
    return 0.001; // minimum fallback
  }
}
