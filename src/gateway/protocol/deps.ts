/**
 * Shared dependencies for protocol handlers.
 *
 * Both the Anthropic and OpenAI handlers need the same set of services:
 * budget checking, metering, provider configs, fetch, and service key resolution.
 */

import type { BudgetChecker } from "../../monetization/budget/budget-checker.js";
import type { CreditLedger } from "../../monetization/credits/credit-ledger.js";
import type { MeterEmitter } from "../../monetization/metering/emitter.js";
import type { CapabilityRateLimitConfig } from "../capability-rate-limit.js";
import type { CircuitBreakerConfig } from "../circuit-breaker.js";
import type { SellRateLookupFn } from "../rate-lookup.js";
import type { FetchFn, GatewayTenant, ProviderConfig } from "../types.js";

export interface ProtocolDeps {
  meter: MeterEmitter;
  budgetChecker: BudgetChecker;
  creditLedger?: CreditLedger;
  topUpUrl: string;
  graceBufferCents?: number;
  providers: ProviderConfig;
  defaultMargin: number;
  fetchFn: FetchFn;
  resolveServiceKey: (key: string) => GatewayTenant | null;
  /** Apply margin to a cost. Defaults to withMargin from adapters/types. */
  withMarginFn: (cost: number, margin: number) => number;
  rateLookupFn?: SellRateLookupFn;
  /** Per-capability rate limit config (req/min). */
  capabilityRateLimitConfig?: Partial<CapabilityRateLimitConfig>;
  /** Circuit breaker config for runaway instance detection. */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
  /** Callback when circuit breaker trips. */
  onCircuitBreakerTrip?: (tenantId: string, instanceId: string, requestCount: number) => void;
}
