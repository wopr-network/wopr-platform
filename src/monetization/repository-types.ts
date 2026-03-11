// Re-export all monetization repository interfaces for callers that want a single import point.

export type {
  IPayRamChargeRepository,
  ITenantCustomerRepository,
  PayRamChargeRecord,
} from "@wopr-network/platform-core/billing";
export type { IAutoTopupSettingsRepository, ICreditLedger } from "@wopr-network/platform-core/credits";
export type { IMeterAggregator, IMeterEmitter } from "@wopr-network/platform-core/metering";
export type { FraudEvent, FraudEventInput, IAffiliateFraudRepository } from "./affiliate/affiliate-fraud-repository.js";
export type {
  AffiliateCode,
  AffiliateReferral,
  AffiliateStats,
  IAffiliateRepository,
} from "./affiliate/drizzle-affiliate-repository.js";
export type { IBudgetChecker } from "./budget/budget-checker.js";
export type { IBotBilling } from "./credits/bot-billing.js";
export type { IDividendRepository } from "./credits/dividend-repository.js";

import type { Credit } from "@wopr-network/platform-core/credits";

export interface DividendStats {
  pool: Credit;
  activeUsers: number;
  perUser: Credit;
  nextDistributionAt: string;
  userEligible: boolean;
  userLastPurchaseAt: string | null;
  userWindowExpiresAt: string | null;
}

export interface DividendHistoryEntry {
  date: string;
  amount: Credit;
  pool: Credit;
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
