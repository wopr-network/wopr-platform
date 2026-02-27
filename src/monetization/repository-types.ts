// Re-export all monetization repository interfaces for callers that want a single import point.

export type { FraudEvent, FraudEventInput, IAffiliateFraudRepository } from "./affiliate/affiliate-fraud-repository.js";
export type {
  AffiliateCode,
  AffiliateReferral,
  AffiliateStats,
  IAffiliateRepository,
} from "./affiliate/drizzle-affiliate-repository.js";
export type { IBudgetChecker } from "./budget/budget-checker.js";
export type { IAutoTopupSettingsRepository } from "./credits/auto-topup-settings-repository.js";
export type { IBotBilling } from "./credits/bot-billing.js";
export type { ICreditLedger } from "./credits/credit-ledger.js";
export type { IDividendRepository } from "./credits/dividend-repository.js";
export type { IMeterAggregator } from "./metering/aggregator.js";
export type { IMeterEmitter } from "./metering/emitter.js";
export type { IPayRamChargeStore, PayRamChargeRecord } from "./payram/charge-store.js";
export type { ITenantCustomerStore } from "./stripe/tenant-store.js";

export interface DividendStats {
  poolCents: number;
  activeUsers: number;
  perUserCents: number;
  nextDistributionAt: string;
  userEligible: boolean;
  userLastPurchaseAt: string | null;
  userWindowExpiresAt: string | null;
}

export interface DividendHistoryEntry {
  date: string;
  amountCents: number;
  poolCents: number;
  activeUsers: number;
}

export interface WebhookSeenEvent {
  eventId: string;
  source: string;
  seenAt: number;
}

export interface ProviderHealthOverride {
  adapter: string;
  healthy: boolean;
  markedAt: number;
}
