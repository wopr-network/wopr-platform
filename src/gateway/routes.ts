/**
 * Gateway routes — mounts all /v1/... endpoints behind service key auth.
 *
 * This is the external API surface that bots consume. All routes require
 * a valid WOPR service key and follow the authenticate -> budget check ->
 * proxy -> meter -> respond pattern.
 */

import { Hono } from "hono";
import { rateLimit } from "../api/middleware/rate-limit.js";
import { logger } from "../config/logger.js";
import { withMargin } from "../monetization/adapters/types.js";
import { audioBodyLimit, llmBodyLimit, mediaBodyLimit, webhookBodyLimit } from "./body-limit.js";
import { capabilityRateLimit } from "./capability-rate-limit.js";
import { circuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./circuit-breaker.js";
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
  phoneOutboundStatus,
  phoneTwimlHangup,
  smsDeliveryStatus,
  smsInbound,
  smsOutbound,
  textCompletions,
  videoGenerations,
} from "./proxy.js";
import { type GatewayAuthEnv, serviceKeyAuth } from "./service-key-auth.js";
import { spendingCapCheck } from "./spending-cap.js";
import type { GatewayConfig } from "./types.js";
import { createTwilioWebhookAuth } from "./webhook-auth.js";

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
    graceBufferCents: config.graceBufferCents,
    providers: config.providers,
    defaultMargin: config.defaultMargin ?? 1.3,
    fetchFn: config.fetchFn ?? fetch,
    resolveServiceKey: config.resolveServiceKey,
    withMarginFn: withMargin,
    rateLookupFn: config.rateLookupFn,
    capabilityRateLimitConfig: config.capabilityRateLimitConfig,
    circuitBreakerConfig: config.circuitBreakerConfig,
    onCircuitBreakerTrip: config.onCircuitBreakerTrip,
    rateLimitRepo: config.rateLimitRepo,
    circuitBreakerRepo: config.circuitBreakerRepo,
  };

  gateway.route("/anthropic", createAnthropicRoutes(protocolDeps));
  gateway.route("/openai", createOpenAIRoutes(protocolDeps));

  // --- Webhook routes (Twilio HMAC signature auth, NOT Bearer) ---
  // These MUST be registered BEFORE the serviceKeyAuth("/*") middleware.
  // Twilio sends X-Twilio-Signature headers, not Bearer tokens.
  if (config.webhookBaseUrl && !config.resolveTenantFromWebhook) {
    logger.warn(
      "Gateway: webhookBaseUrl is set but resolveTenantFromWebhook is missing — Twilio webhook routes will not be registered and webhooks will receive 404",
    );
  }
  if (config.resolveTenantFromWebhook && !config.webhookBaseUrl) {
    logger.warn(
      "Gateway: resolveTenantFromWebhook is set but webhookBaseUrl is missing — Twilio webhook routes will not be registered and webhooks will receive 404",
    );
  }
  if (
    config.providers.twilio?.authToken &&
    config.webhookBaseUrl &&
    config.resolveTenantFromWebhook &&
    !config.sigPenaltyRepo
  ) {
    logger.warn(
      "Gateway: Twilio is configured but sigPenaltyRepo is absent — Twilio webhook routes will not be registered and webhooks will receive 404",
    );
  }
  if (
    config.providers.twilio?.authToken &&
    config.webhookBaseUrl &&
    config.resolveTenantFromWebhook &&
    config.sigPenaltyRepo
  ) {
    const webhookAuth = createTwilioWebhookAuth({
      twilioAuthToken: config.providers.twilio.authToken,
      webhookBaseUrl: config.webhookBaseUrl,
      resolveTenantFromWebhook: config.resolveTenantFromWebhook,
      sigPenaltyRepo: config.sigPenaltyRepo,
    });
    gateway.post("/phone/inbound/:tenantId", webhookBodyLimit(), webhookAuth, phoneInbound(deps));
    gateway.post("/phone/outbound/status/:tenantId", webhookBodyLimit(), webhookAuth, phoneOutboundStatus(deps));
    gateway.post("/messages/sms/inbound/:tenantId", webhookBodyLimit(), webhookAuth, smsInbound(deps));
    gateway.post("/messages/sms/status/:tenantId", webhookBodyLimit(), webhookAuth, smsDeliveryStatus(deps));
  }

  // Self-hosted TwiML endpoint — public, no auth required (Twilio fetches it during call setup).
  // Replaces the third-party http://twiml.ai/hangup used as default TwiML fallback.
  gateway.get("/phone/twiml/hangup", phoneTwimlHangup());

  // All remaining gateway routes require service key authentication via Bearer
  gateway.use("/*", serviceKeyAuth(config.resolveServiceKey));

  // 1. Spending cap enforcement — reject if over daily/monthly cap before consuming rate limit tokens
  if (config.spendingCapStore) {
    gateway.use("/*", spendingCapCheck(config.spendingCapStore, config.spendingCapConfig));
  }

  // 2. Per-capability rate limiting (replaces flat tenantLimit)
  gateway.use("/*", capabilityRateLimit(config.capabilityRateLimitConfig, config.rateLimitRepo));

  // 3. Circuit breaker for runaway instances
  gateway.use(
    "/*",
    circuitBreaker({
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...config.circuitBreakerConfig,
      repo: config.circuitBreakerRepo,
      onTrip: config.onCircuitBreakerTrip,
    }),
  );

  // LLM endpoints (OpenRouter)
  gateway.post("/chat/completions", llmBodyLimit(), chatCompletions(deps));
  gateway.post("/completions", llmBodyLimit(), textCompletions(deps));
  gateway.post("/embeddings", llmBodyLimit(), embeddings(deps));

  // Audio endpoints
  gateway.post("/audio/transcriptions", audioBodyLimit(), audioTranscriptions(deps));
  gateway.post("/audio/speech", audioBodyLimit(), audioSpeech(deps));

  // Image & Video generation (Replicate)
  gateway.post("/images/generations", mediaBodyLimit(), imageGenerations(deps));
  gateway.post("/video/generations", mediaBodyLimit(), videoGenerations(deps));

  // Phone (Twilio/Telnyx)
  gateway.post("/phone/outbound", webhookBodyLimit(), phoneOutbound(deps));

  // Phone Number Management
  gateway.post("/phone/numbers", webhookBodyLimit(), phoneNumberProvision(deps));
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
    repo: config.rateLimitRepo,
    scope: "gateway:sms",
  });

  gateway.post("/messages/sms", smsRateLimit, webhookBodyLimit(), smsOutbound(deps));

  // Model discovery
  gateway.get("/models", modelsHandler(deps));

  return gateway;
}
