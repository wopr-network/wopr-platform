/**
 * Gateway types — configuration and request/response shapes for the API gateway.
 *
 * The gateway is the platform's external API surface. Bots send requests to
 * /v1/... endpoints using WOPR service keys. The gateway authenticates,
 * budget-checks, proxies to upstream providers, meters usage, and responds.
 */

import type { BudgetChecker, SpendLimits } from "../monetization/budget/budget-checker.js";
import type { CreditLedger } from "../monetization/credits/credit-ledger.js";
import type { MeterEmitter } from "../monetization/metering/emitter.js";

/** Billing unit determines how a capability is metered. */
export type BillingUnit =
  | "per-token"
  | "per-request"
  | "per-utterance"
  | "per-synthesis"
  | "per-image"
  | "per-video"
  | "per-minute"
  | "per-message";

/** Upstream provider that fulfills the request. */
export type UpstreamProvider = "openrouter" | "deepgram" | "elevenlabs" | "replicate" | "twilio" | "telnyx";

/** An endpoint definition for a gateway capability. */
export interface GatewayEndpoint {
  /** HTTP method (POST for all API calls, webhook receivers may use POST too) */
  method: "POST";
  /** Route path relative to gateway mount (e.g., "/chat/completions") */
  path: string;
  /** Human-readable capability name */
  capability: string;
  /** Upstream provider that handles this request */
  upstream: UpstreamProvider;
  /** How this capability is billed */
  billingUnit: BillingUnit;
}

/** A resolved tenant from service key authentication. */
export interface GatewayTenant {
  /** Tenant ID */
  id: string;
  /** Spend limits for budget checking */
  spendLimits: SpendLimits;
  /** Plan tier for rate limit lookup */
  planTier?: string;
  /** Instance ID this token belongs to */
  instanceId?: string;
}

/** Fetch function type for dependency injection in tests. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Provider configuration — API keys and base URLs for upstream providers. */
export interface ProviderConfig {
  openrouter?: { apiKey: string; baseUrl?: string };
  deepgram?: { apiKey: string; baseUrl?: string };
  elevenlabs?: { apiKey: string; baseUrl?: string };
  replicate?: { apiToken: string; baseUrl?: string };
  twilio?: { accountSid: string; authToken: string; baseUrl?: string };
  telnyx?: { apiKey: string; baseUrl?: string };
  /** GPU backend configuration (private network, WOP-505) */
  gpu?: {
    /** Base URL for text-gen (llama.cpp). Default: http://gpu-internal:8080 */
    textGen?: { baseUrl: string };
    /** Base URL for TTS (chatterbox). Default: http://gpu-internal:8081 */
    tts?: { baseUrl: string };
    /** Base URL for STT (whisper). Default: http://gpu-internal:8082 */
    stt?: { baseUrl: string };
    /** Base URL for embeddings (qwen). Default: http://gpu-internal:8083 */
    embeddings?: { baseUrl: string };
  };
}

/** Full gateway configuration. */
export interface GatewayConfig {
  /** MeterEmitter instance for usage tracking */
  meter: MeterEmitter;
  /** BudgetChecker instance for pre-call budget validation */
  budgetChecker: BudgetChecker;
  /** CreditLedger instance for deducting credits after proxy calls (optional — if absent, credit deduction is skipped) */
  creditLedger?: CreditLedger;
  /** URL to direct users to when they need to add credits (default: "/dashboard/credits") */
  topUpUrl?: string;
  /** Upstream provider credentials */
  providers: ProviderConfig;
  /** Default margin multiplier (default: 1.3 = 30%) */
  defaultMargin?: number;
  /** Injectable fetch for testing */
  fetchFn?: FetchFn;
  /** Function to resolve a service key to a tenant */
  resolveServiceKey: (key: string) => GatewayTenant | null;
  /** Maximum outbound SMS per tenant per minute (default: 100) */
  smsRateLimit?: number;
  /** Per-tenant requests per minute (default: 60) */
  tenantRateLimit?: number;
  /** Per-capability requests per minute. Keys are capability names. */
  capabilityRateLimits?: Record<string, number>;
}

/** Standard gateway error response. */
export interface GatewayErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

/** Meter event data emitted after a successful proxy call. */
export interface GatewayMeterEvent {
  tenant: string;
  cost: number;
  charge: number;
  capability: string;
  provider: string;
  timestamp: number;
}
