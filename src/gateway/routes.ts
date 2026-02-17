/**
 * Gateway routes — mounts all /v1/... endpoints behind service key auth.
 *
 * This is the external API surface that bots consume. All routes require
 * a valid WOPR service key and follow the authenticate -> budget check ->
 * proxy -> meter -> respond pattern.
 */

import { Hono } from "hono";
import { rateLimit } from "../api/middleware/rate-limit.js";
import { withMargin } from "../monetization/adapters/types.js";
import { modelsHandler } from "./models.js";
import { createAnthropicRoutes } from "./protocol/anthropic.js";
import type { ProtocolDeps } from "./protocol/deps.js";
import { createOpenAIRoutes } from "./protocol/openai.js";
import {
  audioSpeech,
  audioTranscriptions,
  buildProxyDeps,
  chatCompletions,
  embeddings,
  imageGenerations,
  phoneInbound,
  phoneNumberList,
  phoneNumberProvision,
  phoneNumberRelease,
  phoneOutbound,
  smsDeliveryStatus,
  smsInbound,
  smsOutbound,
  textCompletions,
  videoGenerations,
} from "./proxy.js";
import { type GatewayAuthEnv, serviceKeyAuth } from "./service-key-auth.js";
import type { GatewayConfig } from "./types.js";

/**
 * Create the gateway router with all /v1/... endpoints.
 *
 * @param config - Gateway configuration (providers, meter, budget checker, etc.)
 * @returns Hono app to mount at /v1 in the main app
 */
export function createGatewayRoutes(config: GatewayConfig): Hono<GatewayAuthEnv> {
  const gateway = new Hono<GatewayAuthEnv>();
  const deps = buildProxyDeps(config);

  // Protocol-specific routes — these handle their own auth (x-api-key / Bearer)
  const protocolDeps: ProtocolDeps = {
    meter: config.meter,
    budgetChecker: config.budgetChecker,
    creditLedger: config.creditLedger,
    topUpUrl: config.topUpUrl ?? "/dashboard/credits",
    providers: config.providers,
    defaultMargin: config.defaultMargin ?? 1.3,
    fetchFn: config.fetchFn ?? fetch,
    resolveServiceKey: config.resolveServiceKey,
    withMarginFn: withMargin,
  };

  gateway.route("/anthropic", createAnthropicRoutes(protocolDeps));
  gateway.route("/openai", createOpenAIRoutes(protocolDeps));

  // All remaining gateway routes require service key authentication via Bearer
  gateway.use("/*", serviceKeyAuth(config.resolveServiceKey));

  // Per-tenant rate limiting (applies to all gateway endpoints after auth)
  const tenantLimit = rateLimit({
    max: config.tenantRateLimit ?? 60,
    windowMs: 60_000,
    keyGenerator: (c) => {
      const tenant = c.get("gatewayTenant") as { id: string } | undefined;
      return tenant?.id ?? "unknown";
    },
    message: "Rate limit exceeded for your account. Please slow down.",
  });
  gateway.use("/*", tenantLimit);

  // LLM endpoints (OpenRouter)
  gateway.post("/chat/completions", chatCompletions(deps));
  gateway.post("/completions", textCompletions(deps));
  gateway.post("/embeddings", embeddings(deps));

  // Audio endpoints
  gateway.post("/audio/transcriptions", audioTranscriptions(deps));
  gateway.post("/audio/speech", audioSpeech(deps));

  // Image & Video generation (Replicate)
  gateway.post("/images/generations", imageGenerations(deps));
  gateway.post("/video/generations", videoGenerations(deps));

  // Phone (Twilio/Telnyx)
  gateway.post("/phone/outbound", phoneOutbound(deps));
  gateway.post("/phone/inbound", phoneInbound(deps));

  // Phone Number Management
  gateway.post("/phone/numbers", phoneNumberProvision(deps));
  gateway.get("/phone/numbers", phoneNumberList(deps));
  gateway.delete("/phone/numbers/:id", phoneNumberRelease(deps));

  // SMS/MMS (Twilio/Telnyx) — rate-limited per tenant to prevent spam
  const smsRateLimit = rateLimit({
    max: config.smsRateLimit ?? 100,
    windowMs: 60_000,
    keyGenerator: (c) => {
      const tenant = c.get("gatewayTenant") as { id: string } | undefined;
      return tenant?.id ?? "unknown";
    },
    message: "SMS rate limit exceeded. Please slow down.",
  });

  gateway.post("/messages/sms", smsRateLimit, smsOutbound(deps));
  gateway.post("/messages/sms/inbound", smsInbound(deps));
  gateway.post("/messages/sms/status", smsDeliveryStatus(deps));

  // Model discovery
  gateway.get("/models", modelsHandler(deps));

  return gateway;
}
