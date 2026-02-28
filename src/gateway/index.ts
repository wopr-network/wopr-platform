/**
 * Gateway — the platform's external API surface for bots.
 *
 * Bots send requests to /v1/... endpoints using WOPR service keys.
 * The gateway authenticates, budget-checks, proxies to upstream
 * providers, meters usage, and responds.
 */

export {
  type CapabilityRateLimitConfig,
  capabilityRateLimit,
  DEFAULT_CAPABILITY_LIMITS,
  resolveCapabilityCategory,
} from "./capability-rate-limit.js";
export {
  type CircuitBreakerConfig,
  circuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  getCircuitStates,
} from "./circuit-breaker.js";
export { type CreditGateDeps, creditBalanceCheck, debitCredits } from "./credit-gate.js";
export {
  mapBudgetError,
  mapCircuitBreakerError,
  mapCreditsExhaustedError,
  mapProviderError,
  mapSpendingCapError,
} from "./error-mapping.js";
export { gatewayHealthHandler } from "./health.js";
export { type HydrateSpendingCapsConfig, hydrateSpendingCaps } from "./hydrate-spending-caps.js";
export { modelsHandler } from "./models.js";
export {
  anthropicToOpenAI,
  createAnthropicRoutes,
  createOpenAIRoutes,
  estimateAnthropicCost,
  estimateOpenAICost,
  mapToAnthropicError,
  openAIResponseToAnthropic,
  type ProtocolDeps,
} from "./protocol/index.js";
export {
  buildProxyDeps,
  type ProxyDeps,
  phoneNumberList,
  phoneNumberProvision,
  phoneNumberRelease,
  smsDeliveryStatus,
  smsInbound,
  smsOutbound,
} from "./proxy.js";
export { createGatewayRoutes } from "./routes.js";
export { type GatewayAuthEnv, serviceKeyAuth } from "./service-key-auth.js";
export { type SpendingCapConfig, type SpendingCaps, spendingCapCheck } from "./spending-cap.js";
export type { ISpendingCapStore, SpendingCapRecord } from "./spending-cap-store.js";
export { proxySSEStream } from "./streaming.js";
export { validateTwilioSignature } from "./twilio-signature.js";
export type {
  BillingUnit,
  FetchFn,
  GatewayConfig,
  GatewayEndpoint,
  GatewayErrorResponse,
  GatewayMeterEvent,
  GatewayTenant,
  ProviderConfig,
  UpstreamProvider,
} from "./types.js";
export { createTwilioWebhookAuth, type TwilioWebhookAuthConfig } from "./webhook-auth.js";

import type { Hono } from "hono";
import { gatewayHealthHandler } from "./health.js";
import { buildProxyDeps } from "./proxy.js";
import { createGatewayRoutes } from "./routes.js";
import type { GatewayConfig } from "./types.js";

/**
 * Mount the gateway routes on a Hono app at /v1.
 *
 * This is the recommended way to wire the gateway into the main app.
 * Call this once the runtime dependencies (MeterEmitter, BudgetChecker) are ready.
 */
export function mountGateway(app: Hono, config: GatewayConfig): void {
  app.route("/v1", createGatewayRoutes(config));

  // Gateway health endpoint (outside /v1, at /gateway/health)
  const deps = buildProxyDeps(config);
  app.get("/gateway/health", gatewayHealthHandler(deps));
}
