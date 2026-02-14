/**
 * Monetization -- the platform's billing and metering layer.
 *
 * Core never knows about billing, tenancy, or tiers. All monetization
 * lives here in the platform backend.
 *
 * Modules:
 * - quotas/   -- instance quotas and resource limits per user/tier (WOP-282)
 *
 * Implemented modules:
 * - adapters/  -- hosted adapters like woprReplicateAdapter (WOP-301)
 * - metering/  -- fire-and-forget usage events (WOP-299)
 * - socket/    -- adapter orchestrator with metering + tenant routing (WOP-376)
 * - stripe/    -- Stripe credit purchases (WOP-406, replaces WOP-300 subscriptions)
 */

// Adapters (WOP-301, WOP-353, WOP-377, WOP-386, WOP-387)
export { createDeepgramAdapter, type DeepgramAdapterConfig } from "./adapters/deepgram.js";
export { createElevenLabsAdapter, type ElevenLabsAdapterConfig } from "./adapters/elevenlabs.js";
export { createGeminiAdapter, type GeminiAdapterConfig } from "./adapters/gemini.js";
export { createKimiAdapter, type KimiAdapterConfig } from "./adapters/kimi.js";
// Margin config (WOP-364)
export {
  DEFAULT_MARGIN_CONFIG,
  getMargin,
  type MarginConfig,
  type MarginRule,
  withMarginConfig,
} from "./adapters/margin-config.js";
export { createNanoBananaAdapter, type NanoBananaAdapterConfig } from "./adapters/nano-banana.js";
export { createOpenRouterAdapter, type OpenRouterAdapterConfig } from "./adapters/openrouter.js";
export { createReplicateAdapter, type ReplicateAdapterConfig } from "./adapters/replicate.js";
export {
  type AdapterCapability,
  type AdapterResult,
  type EmbeddingsInput,
  type EmbeddingsOutput,
  type ImageGenerationInput,
  type ImageGenerationOutput,
  type MeterEvent,
  type ProviderAdapter,
  type TextGenerationInput,
  type TextGenerationOutput,
  type TranscriptionInput,
  type TranscriptionOutput,
  type TTSInput,
  type TTSOutput,
  withMargin,
} from "./adapters/types.js";
export type { BudgetCheckerConfig, BudgetCheckResult } from "./budget/index.js";
export { BudgetChecker } from "./budget/index.js";
// Feature gating middleware (WOP-283)
export { createFeatureGate, type FeatureGateConfig, type GetUserTier, type HasBillingHold } from "./feature-gate.js";
// Metering (WOP-299 + WOP-284)
export type {
  BillingPeriod,
  BillingPeriodSummary,
  MeterEventNameMap,
  MeterEventRow,
  StripeMeterRecord,
  UsageAggregationWorkerOpts,
  UsageSummary,
} from "./metering/index.js";
export { initMeterSchema, MeterAggregator, MeterEmitter, UsageAggregationWorker } from "./metering/index.js";
export {
  buildQuotaUsage,
  checkInstanceQuota,
  checkSpendLimit,
  type QuotaCheckResult,
  type QuotaUsage,
  type SpendCheckResult,
} from "./quotas/quota-check.js";
export { buildResourceLimits, type ContainerResourceLimits } from "./quotas/resource-limits.js";
export {
  DEFAULT_TIERS,
  type PlanTier,
  type SpendOverride,
  SpendOverrideStore,
  TIER_HIERARCHY,
  type TierName,
  TierStore,
  tierSatisfies,
} from "./quotas/tier-definitions.js";
// Socket layer — adapter orchestrator (WOP-376)
export { AdapterSocket, type SocketConfig, type SocketRequest } from "./socket/socket.js";
// Stripe credit purchases (WOP-406)
export type {
  CreditCheckoutOpts,
  CreditPriceMap,
  CreditPricePoint,
  MeterValidatorOpts,
  PortalSessionOpts,
  StripeBillingConfig,
  StripeUsageReportRow,
  TenantCustomerRow,
  UsageReporterOpts,
  ValidationMode,
  ValidationResult,
  WebhookDeps,
  WebhookResult,
} from "./stripe/index.js";
export {
  CREDIT_PRICE_POINTS,
  createCreditCheckoutSession,
  createPortalSession,
  createStripeClient,
  getConfiguredPriceIds,
  getCreditAmountForPurchase,
  handleWebhookEvent,
  initStripeSchema,
  loadCreditPriceMap,
  loadStripeConfig,
  lookupCreditPrice,
  StripeUsageReporter,
  TenantCustomerStore,
  validateStripeMeters,
} from "./stripe/index.js";
