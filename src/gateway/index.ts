/**
 * Gateway — the platform's external API surface for bots.
 *
 * Bots send requests to /v1/... endpoints using WOPR service keys.
 * The gateway authenticates, budget-checks, proxies to upstream
 * providers, meters usage, and responds.
 */

export { mapProviderError } from "./error-mapping.js";
export {
  createAnthropicRoutes,
  createOpenAIRoutes,
  type ProtocolDeps,
  anthropicToOpenAI,
  openAIResponseToAnthropic,
  mapToAnthropicError,
  estimateAnthropicCost,
  estimateOpenAICost,
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

import type { Hono } from "hono";
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
}
