/**
 * Monetization -- the platform's billing and metering layer.
 *
 * Core never knows about billing, tenancy, or credits. All monetization
 * lives here in the platform backend.
 *
 * Modules:
 * - credits/   -- credit ledger, the single unit of value (WOP-384)
 * - quotas/    -- instance quotas and resource limits per user (WOP-282)
 *
 * Implemented modules:
 * - adapters/  -- hosted adapters like woprReplicateAdapter (WOP-301)
 * - metering/  -- fire-and-forget usage events (WOP-299)
 * - socket/    -- adapter orchestrator with metering + tenant routing (WOP-376)
 * - stripe/    -- Stripe credit purchases (WOP-406)
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
export type { BudgetCheckerConfig, BudgetCheckResult, SpendLimits } from "./budget/index.js";
export { BudgetChecker } from "./budget/index.js";
// Credit ledger (WOP-384)
export type {
  BillingState,
  CreditTransaction,
  CreditType,
  DebitType,
  GetActiveBotCount,
  HistoryOptions,
  OnSuspend,
  RuntimeCronConfig,
  RuntimeCronResult,
  TransactionType,
} from "./credits/index.js";
export {
  BotBilling,
  CreditLedger,
  DAILY_BOT_COST_CENTS,
  grantSignupCredits,
  InsufficientBalanceError,
  runRuntimeDeductions,
  SIGNUP_GRANT_CENTS,
  SUSPENSION_GRACE_DAYS,
} from "./credits/index.js";
// Feature gating middleware (WOP-384 — replaced tier gates with balance gates)
export {
  type CreditGateConfig,
  createBalanceGate,
  createCreditGate,
  createFeatureGate,
  type FeatureGateConfig,
  type GetUserBalance,
  type ResolveTenantId,
} from "./feature-gate.js";
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
export { MeterAggregator, MeterEmitter, UsageAggregationWorker } from "./metering/index.js";
export {
  checkInstanceQuota,
  DEFAULT_INSTANCE_LIMITS,
  type InstanceLimits,
  type QuotaCheckResult,
} from "./quotas/quota-check.js";
export {
  buildResourceLimits,
  type ContainerResourceLimits,
  DEFAULT_RESOURCE_CONFIG,
  type ResourceConfig,
} from "./quotas/resource-limits.js";
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
