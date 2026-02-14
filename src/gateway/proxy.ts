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

/** Wholesale per-message costs (USD). */
const SMS_WHOLESALE_COST = 0.0079;
const MMS_WHOLESALE_COST = 0.02;

/** SMS outbound margin (retail / wholesale). ~2.5x markup. */
const SMS_OUTBOUND_MARGIN = 2.53;
const MMS_OUTBOUND_MARGIN = 2.5;

export function smsOutbound(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        { error: { message: "SMS service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
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

      emitMeterEvent(deps, tenant.id, capability, "twilio", cost, margin);

      return c.json({
        sid: twilioMsg.sid,
        status: twilioMsg.status ?? "queued",
        capability,
      });
    } catch (error) {
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
      const body = await c.req.json<{
        message_sid?: string;
        from: string;
        to: string;
        body: string;
        media_url?: string[];
        num_media?: number;
      }>();

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

      emitMeterEvent(deps, tenant.id, capability, "twilio", cost, margin);

      return c.json({
        status: "received",
        capability,
        message_sid: body.message_sid ?? null,
      });
    } catch (error) {
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
      const body = await c.req.json<{
        message_sid: string;
        message_status: string;
        error_code?: number | null;
        error_message?: string | null;
      }>();

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

/** Phone number monthly wholesale cost. */
const PHONE_NUMBER_MONTHLY_COST = 1.15;
const PHONE_NUMBER_MARGIN = 2.6;

/** Prefix used in Twilio FriendlyName to track tenant ownership. */
const TENANT_NUMBER_PREFIX = "wopr:tenant:";

export function phoneNumberProvision(deps: ProxyDeps) {
  return async (c: Context<GatewayAuthEnv>) => {
    const tenant = c.get("gatewayTenant");
    const budgetErr = budgetCheck(c, deps);
    if (budgetErr) return budgetErr;

    const twilioCfg = deps.providers.twilio;
    if (!twilioCfg) {
      return c.json(
        { error: { message: "Phone service not configured", type: "server_error", code: "service_unavailable" } },
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

      // Meter the initial phone number cost.
      // TODO(WOP-444): Phone numbers are a recurring monthly cost ($1.15/mo).
      // This only bills the first month. A recurring billing scheduler should
      // enumerate active numbers per tenant and emit monthly meter events.
      emitMeterEvent(
        deps,
        tenant.id,
        "phone-number-provision",
        "twilio",
        PHONE_NUMBER_MONTHLY_COST,
        PHONE_NUMBER_MARGIN,
      );

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
        { error: { message: "Phone service not configured", type: "server_error", code: "service_unavailable" } },
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
        { error: { message: "Phone service not configured", type: "server_error", code: "service_unavailable" } },
        503,
      );
    }

    try {
      const numberId = c.req.param("id");
      if (!numberId) {
        return c.json(
          { error: { message: "Missing phone number ID", type: "invalid_request_error", code: "missing_field" } },
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
