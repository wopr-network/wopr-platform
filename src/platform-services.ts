/**
 * Platform-core singleton factories.
 *
 * These singletons wrap platform-core implementations (credits, billing,
 * metering, email, security, admin, tenancy). They all share the same
 * lazy-init + null-guard pattern as fleet/services.ts.
 *
 * Fleet/WOPR-specific singletons stay in fleet/services.ts.
 */

import type { DrizzleDb } from "./db/index.js";

// ---- Re-usable db accessor (injected by fleet/services.ts at startup) ----

let _getDb: (() => DrizzleDb) | null = null;

/** Called once by fleet/services.ts to wire the shared db accessor. */
export function _initPlatformServices(getDb: () => DrizzleDb): void {
  _getDb = getDb;
}

function db(): DrizzleDb {
  if (!_getDb) throw new Error("platform-services not initialized — call _initPlatformServices first");
  return _getDb();
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import { DrizzleCreditLedger } from "@wopr-network/platform-core/credits";

let _creditLedger: ICreditLedger | null = null;

export function getCreditLedger(): ICreditLedger {
  if (!_creditLedger) _creditLedger = new DrizzleCreditLedger(db());
  return _creditLedger;
}

import type { ICreditTransactionRepository } from "./monetization/credits/credit-transaction-repository.js";
import { DrizzleCreditTransactionRepository } from "./monetization/credits/credit-transaction-repository.js";

let _creditTransactionRepo: ICreditTransactionRepository | null = null;

export function getCreditTransactionRepo(): ICreditTransactionRepository {
  if (!_creditTransactionRepo) _creditTransactionRepo = new DrizzleCreditTransactionRepository(db());
  return _creditTransactionRepo;
}

import type { IAutoTopupSettingsRepository } from "@wopr-network/platform-core/credits";
import { DrizzleAutoTopupSettingsRepository } from "@wopr-network/platform-core/credits";

let _autoTopupSettingsRepo: IAutoTopupSettingsRepository | null = null;

export function getAutoTopupSettingsRepo(): IAutoTopupSettingsRepository {
  if (!_autoTopupSettingsRepo) _autoTopupSettingsRepo = new DrizzleAutoTopupSettingsRepository(db());
  return _autoTopupSettingsRepo;
}

import type { IAutoTopupEventLogRepository } from "./monetization/credits/auto-topup-event-log-repository.js";
import { DrizzleAutoTopupEventLogRepository } from "./monetization/credits/auto-topup-event-log-repository.js";

let _autoTopupEventLogRepo: IAutoTopupEventLogRepository | null = null;

export function getAutoTopupEventLogRepo(): IAutoTopupEventLogRepository {
  if (!_autoTopupEventLogRepo) _autoTopupEventLogRepo = new DrizzleAutoTopupEventLogRepository(db());
  return _autoTopupEventLogRepo;
}

import type { IDividendRepository } from "./monetization/credits/dividend-repository.js";
import { DrizzleDividendRepository } from "./monetization/credits/dividend-repository.js";

let _dividendRepo: IDividendRepository | null = null;

export function getDividendRepo(): IDividendRepository {
  if (!_dividendRepo) _dividendRepo = new DrizzleDividendRepository(db());
  return _dividendRepo;
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

import type { IMeterEmitter } from "@wopr-network/platform-core/metering";
import { DrizzleMeterEmitter, DrizzleMeterEventRepository } from "@wopr-network/platform-core/metering";

let _meterEmitter: IMeterEmitter | null = null;

export function getMeterEmitter(): IMeterEmitter {
  if (!_meterEmitter) _meterEmitter = new DrizzleMeterEmitter(new DrizzleMeterEventRepository(db()));
  return _meterEmitter;
}

import type { IMeterAggregator } from "@wopr-network/platform-core/metering";
import { DrizzleMeterAggregator, DrizzleUsageSummaryRepository } from "@wopr-network/platform-core/metering";

let _meterAggregator: IMeterAggregator | null = null;

export function getMeterAggregator(): IMeterAggregator {
  if (!_meterAggregator) _meterAggregator = new DrizzleMeterAggregator(new DrizzleUsageSummaryRepository(db()));
  return _meterAggregator;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

import { DrizzleTenantCustomerRepository, type ITenantCustomerRepository } from "./monetization/index.js";

let _tenantCustomerRepo: ITenantCustomerRepository | null = null;

export function getTenantCustomerRepository(): ITenantCustomerRepository {
  if (!_tenantCustomerRepo) _tenantCustomerRepo = new DrizzleTenantCustomerRepository(db());
  return _tenantCustomerRepo;
}

import type { IPayRamChargeRepository } from "@wopr-network/platform-core/billing";
import { DrizzlePayRamChargeRepository } from "@wopr-network/platform-core/billing";

let _payramChargeRepo: IPayRamChargeRepository | null = null;

export function getPayRamChargeRepository(): IPayRamChargeRepository {
  if (!_payramChargeRepo) _payramChargeRepo = new DrizzlePayRamChargeRepository(db());
  return _payramChargeRepo;
}

import type { IBudgetChecker } from "./monetization/budget/budget-checker.js";
import { DrizzleBudgetChecker } from "./monetization/budget/budget-checker.js";

let _budgetChecker: IBudgetChecker | null = null;

export function getBudgetChecker(): IBudgetChecker {
  if (!_budgetChecker) _budgetChecker = new DrizzleBudgetChecker(db());
  return _budgetChecker;
}

// ---------------------------------------------------------------------------
// Notifications / Email
// ---------------------------------------------------------------------------

import {
  DrizzleNotificationPreferencesStore,
  DrizzleNotificationQueueStore,
  type INotificationPreferencesRepository,
  type INotificationQueueRepository,
} from "@wopr-network/platform-core/email";

let _notificationQueueStore: INotificationQueueRepository | null = null;
let _notificationPrefsStore: INotificationPreferencesRepository | null = null;

export function getNotificationQueueStore(): INotificationQueueRepository {
  if (!_notificationQueueStore) _notificationQueueStore = new DrizzleNotificationQueueStore(db());
  return _notificationQueueStore;
}

export function getNotificationPrefsStore(): INotificationPreferencesRepository {
  if (!_notificationPrefsStore) _notificationPrefsStore = new DrizzleNotificationPreferencesStore(db());
  return _notificationPrefsStore;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

import type { ICredentialRepository } from "@wopr-network/platform-core/security";
import { DrizzleCredentialRepository } from "@wopr-network/platform-core/security";

let _credentialRepo: ICredentialRepository | null = null;

export function getCredentialRepo(): ICredentialRepository {
  if (!_credentialRepo) _credentialRepo = new DrizzleCredentialRepository(db());
  return _credentialRepo;
}

import { DrizzleSecretAuditRepository, type ISecretAuditRepository } from "@wopr-network/platform-core/security";

let _secretAuditRepo: ISecretAuditRepository | null = null;

export function getSecretAuditRepo(): ISecretAuditRepository {
  if (!_secretAuditRepo) _secretAuditRepo = new DrizzleSecretAuditRepository(db());
  return _secretAuditRepo;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

import { DrizzleRateLimitRepository } from "./api/drizzle-rate-limit-repository.js";
import type { IRateLimitRepository } from "./api/rate-limit-repository.js";

let _rateLimitRepo: IRateLimitRepository | null = null;

export function getRateLimitRepo(): IRateLimitRepository {
  if (!_rateLimitRepo) _rateLimitRepo = new DrizzleRateLimitRepository(db());
  return _rateLimitRepo;
}

import type { ICircuitBreakerRepository } from "./gateway/circuit-breaker-repository.js";
import { DrizzleCircuitBreakerRepository } from "./gateway/drizzle-circuit-breaker-repository.js";

let _circuitBreakerRepo: ICircuitBreakerRepository | null = null;

export function getCircuitBreakerRepo(): ICircuitBreakerRepository {
  if (!_circuitBreakerRepo) _circuitBreakerRepo = new DrizzleCircuitBreakerRepository(db());
  return _circuitBreakerRepo;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

import { AdminAuditLog, DrizzleAdminAuditLogRepository } from "@wopr-network/platform-core/admin";

let _adminAuditLog: AdminAuditLog | null = null;

export function getAdminAuditLog(): AdminAuditLog {
  if (!_adminAuditLog) _adminAuditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db()));
  return _adminAuditLog;
}

import type { IAdminNotesRepository } from "./admin/notes/admin-notes-repository.js";
import { AdminNotesStore } from "./admin/notes/store.js";

let _adminNotesRepo: IAdminNotesRepository | null = null;

export function getAdminNotesRepo(): IAdminNotesRepository {
  if (!_adminNotesRepo) _adminNotesRepo = new AdminNotesStore(db());
  return _adminNotesRepo;
}

import type { ITenantStatusRepository } from "./admin/tenant-status/tenant-status-repository.js";
import { TenantStatusStore } from "./admin/tenant-status/tenant-status-store.js";

let _tenantStatusRepo: ITenantStatusRepository | null = null;

export function getTenantStatusRepo(): ITenantStatusRepository {
  if (!_tenantStatusRepo) _tenantStatusRepo = new TenantStatusStore(db());
  return _tenantStatusRepo;
}

import type { IBulkOperationsRepository } from "./admin/bulk/bulk-operations-repository.js";
import { DrizzleBulkOperationsRepository } from "./admin/bulk/bulk-operations-repository.js";

let _bulkOpsRepo: IBulkOperationsRepository | null = null;

export function getBulkOpsRepo(): IBulkOperationsRepository {
  if (!_bulkOpsRepo) _bulkOpsRepo = new DrizzleBulkOperationsRepository(db());
  return _bulkOpsRepo;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

import type { IDeletionRepository } from "./account/deletion-repository.js";
import { DrizzleDeletionRepository } from "./account/deletion-repository.js";

let _deletionRepo: IDeletionRepository | null = null;

export function getDeletionRepo(): IDeletionRepository {
  if (!_deletionRepo) _deletionRepo = new DrizzleDeletionRepository(db());
  return _deletionRepo;
}

import type { IExportRepository } from "./account/export-repository.js";
import { DrizzleExportRepository } from "./account/export-repository.js";

let _exportRepo: IExportRepository | null = null;

export function getExportRepo(): IExportRepository {
  if (!_exportRepo) _exportRepo = new DrizzleExportRepository(db());
  return _exportRepo;
}

// ---------------------------------------------------------------------------
// Tenancy / Org
// ---------------------------------------------------------------------------

import type { IOrgMemberRepository } from "./fleet/org-member-repository.js";
import { DrizzleOrgMemberRepository } from "./fleet/org-member-repository.js";
import type { IOrgMembershipRepository } from "./fleet/org-membership-repository.js";
import { DrizzleOrgMembershipRepository } from "./fleet/org-membership-repository.js";
import type { IOrgRepository } from "./org/drizzle-org-repository.js";
import { DrizzleOrgRepository } from "./org/drizzle-org-repository.js";
import { OrgService } from "./org/org-service.js";

let _orgRepo: IOrgRepository | null = null;
let _orgMemberRepo: IOrgMemberRepository | null = null;
let _orgService: OrgService | null = null;
let _orgMembershipRepo: IOrgMembershipRepository | null = null;

export function getOrgRepo(): IOrgRepository {
  if (!_orgRepo) _orgRepo = new DrizzleOrgRepository(db());
  return _orgRepo;
}

export function getOrgMemberRepo(): IOrgMemberRepository {
  if (!_orgMemberRepo) _orgMemberRepo = new DrizzleOrgMemberRepository(db());
  return _orgMemberRepo;
}

export function getOrgService(): OrgService {
  if (!_orgService) _orgService = new OrgService(getOrgRepo(), getOrgMemberRepo(), db());
  return _orgService;
}

export function getOrgMembershipRepo(): IOrgMembershipRepository {
  if (!_orgMembershipRepo) _orgMembershipRepo = new DrizzleOrgMembershipRepository(db());
  return _orgMembershipRepo;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

import type { IUserRoleRepository } from "./auth/user-role-repository.js";
import { DrizzleUserRoleRepository } from "./auth/user-role-repository.js";

let _userRoleRepo: IUserRoleRepository | null = null;

export function getUserRoleRepo(): IUserRoleRepository {
  if (!_userRoleRepo) _userRoleRepo = new DrizzleUserRoleRepository(db());
  return _userRoleRepo;
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

import type { ICouponRepository } from "./monetization/promotions/coupon-repository.js";
import { DrizzleCouponRepository } from "./monetization/promotions/coupon-repository.js";
import { PromotionEngine } from "./monetization/promotions/engine.js";
import type { IPromotionRepository } from "./monetization/promotions/promotion-repository.js";
import { DrizzlePromotionRepository } from "./monetization/promotions/promotion-repository.js";
import type { IRedemptionRepository } from "./monetization/promotions/redemption-repository.js";
import { DrizzleRedemptionRepository } from "./monetization/promotions/redemption-repository.js";

let _promotionRepo: IPromotionRepository | null = null;
let _couponRepo: ICouponRepository | null = null;
let _redemptionRepo: IRedemptionRepository | null = null;
let _promotionEngine: PromotionEngine | null = null;

export function getPromotionRepository(): IPromotionRepository {
  if (!_promotionRepo) _promotionRepo = new DrizzlePromotionRepository(db());
  return _promotionRepo;
}

export function getCouponRepository(): ICouponRepository {
  if (!_couponRepo) _couponRepo = new DrizzleCouponRepository(db());
  return _couponRepo;
}

export function getRedemptionRepository(): IRedemptionRepository {
  if (!_redemptionRepo) _redemptionRepo = new DrizzleRedemptionRepository(db());
  return _redemptionRepo;
}

export function getPromotionEngine(): PromotionEngine {
  if (!_promotionEngine) {
    _promotionEngine = new PromotionEngine({
      promotionRepo: getPromotionRepository(),
      couponRepo: getCouponRepository(),
      redemptionRepo: getRedemptionRepository(),
      ledger: getCreditLedger(),
    });
  }
  return _promotionEngine;
}

// ---------------------------------------------------------------------------
// Adapter rate overrides
// ---------------------------------------------------------------------------

import type { IAdapterRateOverrideRepository } from "./monetization/adapters/rate-override-repository.js";
import {
  AdapterRateOverrideCache,
  DrizzleAdapterRateOverrideRepository,
} from "./monetization/adapters/rate-override-repository.js";

let _rateOverrideRepo: IAdapterRateOverrideRepository | null = null;
let _rateOverrideCache: AdapterRateOverrideCache | null = null;

export function getRateOverrideRepository(): IAdapterRateOverrideRepository {
  if (!_rateOverrideRepo) _rateOverrideRepo = new DrizzleAdapterRateOverrideRepository(db());
  return _rateOverrideRepo;
}

export function getRateOverrideCache(): AdapterRateOverrideCache {
  if (!_rateOverrideCache) _rateOverrideCache = new AdapterRateOverrideCache(getRateOverrideRepository());
  return _rateOverrideCache;
}

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

import type { ITenantAddonRepository } from "./monetization/addons/addon-repository.js";
import { DrizzleTenantAddonRepository } from "./monetization/addons/addon-repository.js";

let _tenantAddonRepo: ITenantAddonRepository | undefined;

export function getTenantAddonRepo(): ITenantAddonRepository {
  if (!_tenantAddonRepo) _tenantAddonRepo = new DrizzleTenantAddonRepository(db());
  return _tenantAddonRepo;
}

// ---------------------------------------------------------------------------
// Test helpers — NOT for production use
// ---------------------------------------------------------------------------

/** @internal Reset all platform singletons. Call in afterAll to prevent cross-test leakage. */
export function _resetPlatformForTest(): void {
  _getDb = null;
  _creditLedger = null;
  _creditTransactionRepo = null;
  _autoTopupSettingsRepo = null;
  _autoTopupEventLogRepo = null;
  _dividendRepo = null;
  _meterEmitter = null;
  _meterAggregator = null;
  _tenantCustomerRepo = null;
  _payramChargeRepo = null;
  _budgetChecker = null;
  _notificationQueueStore = null;
  _notificationPrefsStore = null;
  _credentialRepo = null;
  _secretAuditRepo = null;
  _rateLimitRepo = null;
  _circuitBreakerRepo = null;
  _adminAuditLog = null;
  _adminNotesRepo = null;
  _tenantStatusRepo = null;
  _bulkOpsRepo = null;
  _deletionRepo = null;
  _exportRepo = null;
  _orgRepo = null;
  _orgMemberRepo = null;
  _orgService = null;
  _orgMembershipRepo = null;
  _userRoleRepo = null;
  _promotionRepo = null;
  _couponRepo = null;
  _redemptionRepo = null;
  _promotionEngine = null;
  _rateOverrideRepo = null;
  _rateOverrideCache = null;
  _tenantAddonRepo = undefined;
}
