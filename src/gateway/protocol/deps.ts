/**
 * Shared dependencies for protocol handlers.
 *
 * Both the Anthropic and OpenAI handlers need the same set of services:
 * budget checking, metering, provider configs, fetch, and service key resolution.
 */

import type { IRateLimitRepository } from "../../api/rate-limit-repository.js";
import type { BudgetChecker } from "../../monetization/budget/budget-checker.js";
import type { Credit } from "../../monetization/credit.js";
import type { CreditLedger } from "../../monetization/credits/credit-ledger.js";
import type { MeterEmitter } from "../../monetization/metering/emitter.js";
import type { CapabilityRateLimitConfig } from "../capability-rate-limit.js";
import type { CircuitBreakerConfig } from "../circuit-breaker.js";
import type { ICircuitBreakerRepository } from "../circuit-breaker-repository.js";
import type { SellRateLookupFn } from "../rate-lookup.js";
import type { FetchFn, GatewayTenant, ProviderConfig } from "../types.js";

export interface ProtocolDeps {
  meter: MeterEmitter;
  budgetChecker: BudgetChecker;
  creditLedger?: CreditLedger;
  topUpUrl: string;
  graceBuffer?: import("../../monetization/credit.js").Credit;
  providers: ProviderConfig;
  defaultMargin: number;
  fetchFn: FetchFn;
  resolveServiceKey: (key: string) => GatewayTenant | null;
  /** Apply margin to a cost. Defaults to withMargin from adapters/types. */
  withMarginFn: (cost: Credit, margin: number) => Credit;
  rateLookupFn?: SellRateLookupFn;
  /** Per-capability rate limit config (req/min). */
  capabilityRateLimitConfig?: Partial<CapabilityRateLimitConfig>;
  /** Circuit breaker config for runaway instance detection. */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
  /** Callback when circuit breaker trips. */
  onCircuitBreakerTrip?: (tenantId: string, instanceId: string, requestCount: number) => void;
  /** Repository for per-capability rate limit counters. Required when rate limiting is active. */
  rateLimitRepo?: IRateLimitRepository;
  /** Repository for circuit breaker state. Required when circuit breaker is active. */
  circuitBreakerRepo?: ICircuitBreakerRepository;
}
