/**
 * Arbitrage router types — provider entries, routing decisions, and margin tracking.
 *
 * WOP-463: Provider arbitrage router for multi-provider routing with maximum margin.
 */

/** A provider entry in the routing registry. Maps to provider_costs DB rows. */
export interface ModelProviderEntry {
  /** Capability or model name */
  capability: string;
  /** Which adapter serves it (matches ProviderAdapter.name) */
  adapter: string;
  /** Provider tier — GPU infra vs hosted third-party */
  tier: "gpu" | "hosted";
  /** Provider's cost to us per unit in USD */
  providerCost: number;
  /** Cost unit description */
  costUnit: string;
  /** Is this provider currently healthy? */
  healthy: boolean;
  /** Priority within same tier (lower = preferred, tiebreaker when costs equal) */
  priority: number;
  /** Latency class */
  latencyClass: "fast" | "normal" | "slow";
  /** Whether this provider is enabled by admin */
  enabled: boolean;
}

/** Result of a routing decision. */
export interface RoutingDecision {
  /** The selected provider entry */
  provider: ModelProviderEntry;
  /** All candidates that were considered (for logging/debugging) */
  candidates: ModelProviderEntry[];
  /** Why this provider was selected */
  reason: "gpu-cheapest" | "hosted-cheapest" | "fallback" | "only-option";
}

/** Margin tracking record emitted per-request. */
export interface MarginRecord {
  /** Tenant who made the request */
  tenantId: string;
  /** Capability requested */
  capability: string;
  /** Provider that fulfilled it */
  adapter: string;
  /** Provider tier */
  tier: "gpu" | "hosted";
  /** What we paid the provider (USD) */
  providerCost: number;
  /** What we charged the user (USD) */
  sellPrice: number;
  /** Margin = sellPrice - providerCost */
  margin: number;
  /** Margin percentage = margin / sellPrice * 100 */
  marginPct: number;
  /** Unix epoch ms */
  timestamp: number;
}

export class NoProviderAvailableError extends Error {
  readonly capability: string;
  readonly httpStatus = 503;

  constructor(capability: string) {
    super(`No provider available for capability "${capability}"`);
    this.name = "NoProviderAvailableError";
    this.capability = capability;
  }
}
