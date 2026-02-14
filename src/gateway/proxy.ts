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
import { logger } from "../config/logger.js";
import { withMargin } from "../monetization/adapters/types.js";
import type { BudgetChecker } from "../monetization/budget/budget-checker.js";
import type { MeterEmitter } from "../monetization/metering/emitter.js";
import { mapProviderError } from "./error-mapping.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";
import type { FetchFn, GatewayConfig, ProviderConfig } from "./types.js";

const DEFAULT_MARGIN = 1.3;

/** Shared state for all proxy handlers. */
export interface ProxyDeps {
  meter: MeterEmitter;
  budgetChecker: BudgetChecker;
  providers: ProviderConfig;
  defaultMargin: number;
  fetchFn: FetchFn;
}

export function buildProxyDeps(config: GatewayConfig): ProxyDeps {
  return {
    meter: config.meter,
    budgetChecker: config.budgetChecker,
    providers: config.providers,
    defaultMargin: config.defaultMargin ?? DEFAULT_MARGIN,
    fetchFn: config.fetchFn ?? fetch,
  };
}

/**
 * Run the pre-call budget check. Returns an error response if budget is exceeded.
 */
function budgetCheck(c: Context<GatewayAuthEnv>, deps: ProxyDeps): Response | null {
  const tenant = c.get("gatewayTenant");
  const result = deps.budgetChecker.check(tenant.id, tenant.spendLimits);

  if (!result.allowed) {
    const status = result.httpStatus ?? 429;
    return c.json(
      {
        error: {
          message: result.reason ?? "Budget exceeded",
          type: "billing_error",
          code: "insufficient_credits",
        },
      },
      status as 429,
    );
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
  cost: number,
  margin?: number,
): void {
  const charge = withMargin(cost, margin ?? deps.defaultMargin);
  deps.meter.emit({
    tenant: tenantId,
    cost,
    charge,
    capability,
    provider,
    timestamp: Date.now(),
  });
}

// -----------------------------------------------------------------------
// LLM Chat Completions — POST /v1/chat/completions
// -----------------------------------------------------------------------

export function chatCompletions(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        { error: { message: "LLM service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
      const body = await c.req.text();
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

      const res = await deps.fetchFn(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerCfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      const responseBody = await res.text();
      const costHeader = res.headers.get("x-openrouter-cost");
      const cost = costHeader ? parseFloat(costHeader) : estimateTokenCost(responseBody);

      logger.info("Gateway proxy: chat/completions", {
        tenant: tenant.id,
        status: res.status,
        cost,
      });

      if (res.ok) {
        emitMeterEvent(deps, tenant.id, "chat-completions", "openrouter", cost);
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        { error: { message: "LLM service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
      const body = await c.req.text();
      const baseUrl = providerCfg.baseUrl ?? "https://openrouter.ai/api";

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
      const cost = costHeader ? parseFloat(costHeader) : estimateTokenCost(responseBody);

      logger.info("Gateway proxy: completions", { tenant: tenant.id, status: res.status, cost });

      if (res.ok) {
        emitMeterEvent(deps, tenant.id, "text-completions", "openrouter", cost);
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.openrouter;
    if (!providerCfg) {
      return c.json(
        { error: { message: "Embeddings service not configured", type: "server_error", code: "service_unavailable" } },
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
      const cost = costHeader ? parseFloat(costHeader) : 0.0001; // flat fallback for embeddings

      logger.info("Gateway proxy: embeddings", { tenant: tenant.id, status: res.status, cost });

      if (res.ok) {
        emitMeterEvent(deps, tenant.id, "embeddings", "openrouter", cost);
      }

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.deepgram;
    if (!providerCfg) {
      return c.json(
        { error: { message: "STT service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
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
      try {
        const parsed = JSON.parse(responseBody) as { metadata?: { duration?: number } };
        if (parsed.metadata?.duration) {
          cost = (parsed.metadata.duration / 60) * 0.0043; // Nova-2 wholesale rate
        }
      } catch {
        // use fallback cost
      }

      logger.info("Gateway proxy: audio/transcriptions", { tenant: tenant.id, status: res.status, cost });
      emitMeterEvent(deps, tenant.id, "transcription", "deepgram", cost);

      return new Response(responseBody, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.elevenlabs;
    if (!providerCfg) {
      return c.json(
        { error: { message: "TTS service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
      const body = await c.req.json<{ input?: string; voice?: string; model?: string; response_format?: string }>();
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

      logger.info("Gateway proxy: audio/speech", { tenant: tenant.id, characters: characterCount, cost });
      emitMeterEvent(deps, tenant.id, "tts", "elevenlabs", cost);

      const audioBuffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "audio/mpeg";

      return new Response(audioBuffer, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.replicate;
    if (!providerCfg) {
      return c.json(
        { error: { message: "Image service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
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

      const prediction = (await res.json()) as { output?: string[]; metrics?: { predict_time?: number } };
      const predictTime = prediction.metrics?.predict_time ?? 5;
      const cost = predictTime * 0.0023; // SDXL wholesale rate

      logger.info("Gateway proxy: images/generations", { tenant: tenant.id, cost });
      emitMeterEvent(deps, tenant.id, "image-generation", "replicate", cost);

      // Return in OpenAI-compatible format
      const images = Array.isArray(prediction.output) ? prediction.output : [];
      return c.json({
        created: Math.floor(Date.now() / 1000),
        data: images.map((url) => ({ url })),
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.replicate;
    if (!providerCfg) {
      return c.json(
        { error: { message: "Video service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
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

      const prediction = (await res.json()) as { output?: string; metrics?: { predict_time?: number } };
      const predictTime = prediction.metrics?.predict_time ?? 30;
      const cost = predictTime * 0.005; // video gen wholesale rate

      logger.info("Gateway proxy: video/generations", { tenant: tenant.id, cost });
      emitMeterEvent(deps, tenant.id, "video-generation", "replicate", cost);

      return c.json({
        created: Math.floor(Date.now() / 1000),
        data: [{ url: prediction.output ?? "" }],
      });
    } catch (error) {
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
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.twilio ?? deps.providers.telnyx;
    const providerName = deps.providers.twilio ? "twilio" : "telnyx";
    if (!providerCfg) {
      return c.json(
        { error: { message: "Phone service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
      const body = await c.req.json<{ to: string; from: string; webhook_url?: string }>();

      // TODO: Make HTTP call to Twilio/Telnyx API to actually initiate the call.
      // Metering should only happen after a successful upstream response.
      logger.info("Gateway proxy: phone/outbound (stub)", { tenant: tenant.id, to: body.to });

      return c.json({
        status: "initiated",
        message: "Call initiated. Per-minute billing will be applied during the active call.",
      });
    } catch (error) {
      logger.error("Gateway proxy error: phone/outbound", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, providerName);
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
      const body = await c.req.json<{
        call_sid?: string;
        duration_minutes?: number;
        status?: string;
      }>();

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

      emitMeterEvent(deps, tenant.id, "phone-inbound", providerName, cost);

      return c.json({ status: "metered", duration_minutes: durationMinutes });
    } catch (error) {
      logger.error("Gateway proxy error: phone/inbound", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, providerName);
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// SMS Outbound — POST /v1/messages/sms
// -----------------------------------------------------------------------

export function smsOutbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const providerCfg = deps.providers.twilio ?? deps.providers.telnyx;
    const providerName = deps.providers.twilio ? "twilio" : "telnyx";
    if (!providerCfg) {
      return c.json(
        { error: { message: "SMS service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
      const body = await c.req.json<{
        to: string;
        from: string;
        body: string;
        media_url?: string[];
      }>();

      // Determine if MMS (has media attachments)
      const isMMS = body.media_url && body.media_url.length > 0;
      const capability = isMMS ? "mms-outbound" : "sms-outbound";

      // TODO: Make HTTP call to Twilio/Telnyx API to actually send the message.
      // Metering should only happen after a successful upstream response.
      logger.info("Gateway proxy: messages/sms (stub)", {
        tenant: tenant.id,
        capability,
        to: body.to,
      });

      return c.json({
        status: "sent",
        capability,
        message: `${isMMS ? "MMS" : "SMS"} sent successfully.`,
      });
    } catch (error) {
      logger.error("Gateway proxy error: messages/sms", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, providerName);
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// SMS Inbound — POST /v1/messages/sms/inbound (webhook from Twilio/Telnyx)
// -----------------------------------------------------------------------

export function smsInbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const providerName = deps.providers.twilio ? "twilio" : "telnyx";

    try {
      const body = await c.req.json<{
        from: string;
        to: string;
        body: string;
        media_url?: string[];
      }>();

      const isMMS = body.media_url && body.media_url.length > 0;
      const capability = isMMS ? "mms-inbound" : "sms-inbound";
      const costPerMessage = isMMS ? 0.02 : 0.0075;

      logger.info("Gateway proxy: messages/sms/inbound", {
        tenant: tenant.id,
        capability,
        from: body.from,
      });

      emitMeterEvent(deps, tenant.id, capability, providerName, costPerMessage);

      return c.json({ status: "received", capability });
    } catch (error) {
      logger.error("Gateway proxy error: messages/sms/inbound", { tenant: tenant.id, error });
      const mapped = mapProviderError(error, providerName);
      return c.json(mapped.body, mapped.status as 502);
    }
  };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Estimate token cost from an OpenAI-compatible response body. */
function estimateTokenCost(responseBody: string): number {
  try {
    const parsed = JSON.parse(responseBody) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const inputTokens = parsed.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed.usage?.completion_tokens ?? 0;
    return inputTokens * 0.000001 + outputTokens * 0.000002;
  } catch {
    return 0.001; // minimum fallback
  }
}
