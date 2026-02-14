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
 * - stripe/    -- Stripe usage-based billing (WOP-300)
 */

// Adapters (WOP-301, WOP-377)
export { createOpenRouterAdapter, type OpenRouterAdapterConfig } from "./adapters/openrouter.js";
export { createReplicateAdapter, type ReplicateAdapterConfig } from "./adapters/replicate.js";
export {
  type AdapterCapability,
  type AdapterResult,
  type ImageGenerationInput,
  type ImageGenerationOutput,
  type MeterEvent,
  type ProviderAdapter,
  type TextGenerationInput,
  type TextGenerationOutput,
  type TranscriptionInput,
  type TranscriptionOutput,
  withMargin,
} from "./adapters/types.js";
export type { BudgetCheckerConfig, BudgetCheckResult } from "./budget/index.js";
export { BudgetChecker } from "./budget/index.js";
// Feature gating middleware (WOP-283)
export { createFeatureGate, type FeatureGateConfig, type GetUserTier } from "./feature-gate.js";
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
export type {
  CheckoutSessionOpts,
  MeterValidatorOpts,
  PortalSessionOpts,
  StripeBillingConfig,
  StripeUsageReportRow,
  TenantCustomerRow,
  UsageReporterOpts,
  ValidationMode,
  ValidationResult,
  WebhookResult,
} from "./stripe/index.js";
// Stripe billing (WOP-300)
export {
  createCheckoutSession,
  createPortalSession,
  createStripeClient,
  handleWebhookEvent,
  initStripeSchema,
  loadStripeConfig,
  StripeUsageReporter,
  TenantCustomerStore,
  validateStripeMeters,
} from "./stripe/index.js";
