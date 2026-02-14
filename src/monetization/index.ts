/**
 * Monetization -- the platform's billing and metering layer.
 *
 * Core never knows about billing, tenancy, or tiers. All monetization
 * lives here in the platform backend.
 *
 * Modules:
 * - quotas/   -- instance quotas and resource limits per user/tier (WOP-282)
 *
 * Planned modules (see WOP-216 epic):
 * - socket/    -- withMargin() wrapper (WOP-298)
 *
 * Implemented modules:
 * - adapters/  -- hosted adapters like woprReplicateAdapter (WOP-301)
 * - metering/  -- fire-and-forget usage events (WOP-299)
 * - stripe/    -- Stripe usage-based billing (WOP-300)
 */

// Adapters (WOP-301)
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
export { buildQuotaUsage, checkInstanceQuota, type QuotaCheckResult, type QuotaUsage } from "./quotas/quota-check.js";
export { buildResourceLimits, type ContainerResourceLimits } from "./quotas/resource-limits.js";
export {
  DEFAULT_TIERS,
  type PlanTier,
  TIER_HIERARCHY,
  type TierName,
  TierStore,
  tierSatisfies,
} from "./quotas/tier-definitions.js";
export type {
  CheckoutSessionOpts,
  PortalSessionOpts,
  StripeBillingConfig,
  StripeUsageReportRow,
  TenantCustomerRow,
  UsageReporterOpts,
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
} from "./stripe/index.js";
