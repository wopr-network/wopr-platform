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
 * - metering/  -- fire-and-forget usage events (WOP-299)
 * - stripe/    -- Stripe usage-based billing (WOP-300)
 *
 * Implemented modules:
 * - adapters/  -- hosted adapters like woprReplicateAdapter (WOP-301)
 */

// Adapters (WOP-301)
export { createReplicateAdapter, type ReplicateAdapterConfig } from "./adapters/replicate.js";
export {
  type AdapterCapability,
  type AdapterResult,
  type MeterEvent,
  type ProviderAdapter,
  type TranscriptionInput,
  type TranscriptionOutput,
  withMargin,
} from "./adapters/types.js";

// Metering (WOP-299)
export type { MeterEventRow, UsageSummary } from "./metering/index.js";
export { initMeterSchema, MeterAggregator, MeterEmitter } from "./metering/index.js";
export { buildQuotaUsage, checkInstanceQuota, type QuotaCheckResult, type QuotaUsage } from "./quotas/quota-check.js";
export { buildResourceLimits, type ContainerResourceLimits } from "./quotas/resource-limits.js";
export { DEFAULT_TIERS, type PlanTier, TierStore } from "./quotas/tier-definitions.js";
