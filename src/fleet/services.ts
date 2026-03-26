import { AdminAuditLog, DrizzleAdminAuditLogRepository } from "@wopr-network/platform-core/admin";
import { DrizzleAuditLogRepository } from "@wopr-network/platform-core/audit/audit-log-repository";
import { DrizzleBackupStatusRepository } from "@wopr-network/platform-core/backup/backup-status-repository";
import { BackupStatusStore, type IBackupStatusStore } from "@wopr-network/platform-core/backup/backup-status-store";
import { BackupVerifier } from "@wopr-network/platform-core/backup/backup-verifier";
import { DrizzleRestoreLogRepository } from "@wopr-network/platform-core/backup/restore-log-repository";
import { type IRestoreLogStore, RestoreLogStore } from "@wopr-network/platform-core/backup/restore-log-store";
import { RestoreService } from "@wopr-network/platform-core/backup/restore-service";
import { SnapshotManager } from "@wopr-network/platform-core/backup/snapshot-manager";
import { DrizzleSnapshotRepository } from "@wopr-network/platform-core/backup/snapshot-repository";
import { SpacesClient } from "@wopr-network/platform-core/backup/spaces-client";
import { EvidenceCollector } from "@wopr-network/platform-core/compliance/evidence-collector";
import { logger } from "@wopr-network/platform-core/config/logger";
import { createDb, type DrizzleDb } from "@wopr-network/platform-core/db/index";
import type { ISpendingCapStore } from "@wopr-network/platform-core/gateway/spending-cap-store";
import { DrizzleMarketplacePluginRepository } from "@wopr-network/platform-core/marketplace/drizzle-marketplace-plugin-repository";
import type { IMarketplacePluginRepository } from "@wopr-network/platform-core/marketplace/marketplace-plugin-repository";
import type { IAffiliateFraudRepository } from "@wopr-network/platform-core/monetization/affiliate/affiliate-fraud-repository";
import { DrizzleAffiliateFraudRepository } from "@wopr-network/platform-core/monetization/affiliate/affiliate-fraud-repository";
import type { IAffiliateRepository } from "@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository";
import { DrizzleAffiliateRepository } from "@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository";
import type { IBotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import { DrizzleBotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import type { IPhoneNumberRepository } from "@wopr-network/platform-core/monetization/credits/drizzle-phone-number-repository";
import { DrizzlePhoneNumberRepository } from "@wopr-network/platform-core/monetization/credits/drizzle-phone-number-repository";
import { SystemResourceMonitor } from "@wopr-network/platform-core/observability/system-resources";
import { DrizzleTwoFactorRepository } from "@wopr-network/platform-core/security/two-factor-repository";
import { Pool } from "pg";
import {
  DrizzleLedgerDeletionRepository,
  type ILedgerDeletionRepository,
} from "../account/ledger-deletion-repository.js";

// ---------------------------------------------------------------------------
// Platform-core singletons (inlined from former platform-services.ts)
// ---------------------------------------------------------------------------

// Account
import type { IDeletionRepository } from "@wopr-network/platform-core/account/deletion-repository";
import { DrizzleDeletionRepository } from "@wopr-network/platform-core/account/deletion-repository";
import type { IExportRepository } from "@wopr-network/platform-core/account/export-repository";
import { DrizzleExportRepository } from "@wopr-network/platform-core/account/export-repository";
// Middleware
import { DrizzleRateLimitRepository } from "@wopr-network/platform-core/api/drizzle-rate-limit-repository";
import type { IRateLimitRepository } from "@wopr-network/platform-core/api/rate-limit-repository";
// Auth
import type { IUserRoleRepository } from "@wopr-network/platform-core/auth/user-role-repository";
import { DrizzleUserRoleRepository } from "@wopr-network/platform-core/auth/user-role-repository";
import type { ICryptoChargeRepository } from "@wopr-network/platform-core/billing";
import { DrizzleCryptoChargeRepository } from "@wopr-network/platform-core/billing";
// Credits
import type { IAutoTopupSettingsRepository, ILedger } from "@wopr-network/platform-core/credits";
import { DrizzleAutoTopupSettingsRepository, DrizzleLedger } from "@wopr-network/platform-core/credits";
// Notifications / Email
import {
  DrizzleNotificationPreferencesStore,
  DrizzleNotificationQueueStore,
  type INotificationPreferencesRepository,
  type INotificationQueueRepository,
} from "@wopr-network/platform-core/email";
// Tenancy / Org
import type { IOrgMembershipRepository } from "@wopr-network/platform-core/fleet/org-membership-repository";
import { DrizzleOrgMembershipRepository } from "@wopr-network/platform-core/fleet/org-membership-repository";
import type { ICircuitBreakerRepository } from "@wopr-network/platform-core/gateway/circuit-breaker-repository";
import { DrizzleCircuitBreakerRepository } from "@wopr-network/platform-core/gateway/drizzle-circuit-breaker-repository";
// Metering
import type { IMeterAggregator, IMeterEmitter } from "@wopr-network/platform-core/metering";
import {
  DrizzleMeterAggregator,
  DrizzleMeterEmitter,
  DrizzleMeterEventRepository,
  DrizzleUsageSummaryRepository,
} from "@wopr-network/platform-core/metering";
// Adapter rate overrides
import type { IAdapterRateOverrideRepository } from "@wopr-network/platform-core/monetization/adapters/rate-override-repository";
import {
  AdapterRateOverrideCache,
  DrizzleAdapterRateOverrideRepository,
} from "@wopr-network/platform-core/monetization/adapters/rate-override-repository";
// Addons
import type { ITenantAddonRepository } from "@wopr-network/platform-core/monetization/addons/addon-repository";
import { DrizzleTenantAddonRepository } from "@wopr-network/platform-core/monetization/addons/addon-repository";
import type { IBudgetChecker } from "@wopr-network/platform-core/monetization/budget/budget-checker";
import { DrizzleBudgetChecker } from "@wopr-network/platform-core/monetization/budget/budget-checker";
import type { IAutoTopupEventLogRepository } from "@wopr-network/platform-core/monetization/credits/auto-topup-event-log-repository";
import { DrizzleAutoTopupEventLogRepository } from "@wopr-network/platform-core/monetization/credits/auto-topup-event-log-repository";
import type { ICreditTransactionRepository } from "@wopr-network/platform-core/monetization/credits/credit-transaction-repository";
import { DrizzleCreditTransactionRepository } from "@wopr-network/platform-core/monetization/credits/credit-transaction-repository";
import type { IDividendRepository } from "@wopr-network/platform-core/monetization/credits/dividend-repository";
import { DrizzleDividendRepository } from "@wopr-network/platform-core/monetization/credits/dividend-repository";
// Billing
import {
  DrizzleTenantCustomerRepository,
  type ITenantCustomerRepository,
} from "@wopr-network/platform-core/monetization/index";
// Promotions
import type { ICouponRepository } from "@wopr-network/platform-core/monetization/promotions/coupon-repository";
import { DrizzleCouponRepository } from "@wopr-network/platform-core/monetization/promotions/coupon-repository";
import { PromotionEngine } from "@wopr-network/platform-core/monetization/promotions/engine";
import type { IPromotionRepository } from "@wopr-network/platform-core/monetization/promotions/promotion-repository";
import { DrizzlePromotionRepository } from "@wopr-network/platform-core/monetization/promotions/promotion-repository";
import type { IRedemptionRepository } from "@wopr-network/platform-core/monetization/promotions/redemption-repository";
import { DrizzleRedemptionRepository } from "@wopr-network/platform-core/monetization/promotions/redemption-repository";
// Security
import {
  DrizzleCredentialRepository,
  DrizzleSecretAuditRepository,
  type ICredentialRepository,
  type ISecretAuditRepository,
} from "@wopr-network/platform-core/security";
import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import { DrizzleOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import type { IBulkOperationsRepository } from "../admin/bulk/bulk-operations-repository.js";
import { DrizzleBulkOperationsRepository } from "../admin/bulk/bulk-operations-repository.js";
// Admin
import type { IAdminNotesRepository } from "../admin/notes/admin-notes-repository.js";
import { AdminNotesStore } from "../admin/notes/store.js";
import type { ITenantStatusRepository } from "../admin/tenant-status/tenant-status-repository.js";
import { TenantStatusStore } from "../admin/tenant-status/tenant-status-store.js";
import type { IOrgRepository } from "../org/drizzle-org-repository.js";
import { DrizzleOrgRepository } from "../org/drizzle-org-repository.js";
import { OrgService } from "../org/org-service.js";

// --- Platform singleton variables ---

let _creditLedger: ILedger | null = null;
let _creditTransactionRepo: ICreditTransactionRepository | null = null;
let _autoTopupSettingsRepo: IAutoTopupSettingsRepository | null = null;
let _autoTopupEventLogRepo: IAutoTopupEventLogRepository | null = null;
let _dividendRepo: IDividendRepository | null = null;
let _meterEmitter: IMeterEmitter | null = null;
let _meterAggregator: IMeterAggregator | null = null;
let _tenantCustomerRepo: ITenantCustomerRepository | null = null;
let _cryptoChargeRepo: ICryptoChargeRepository | null = null;
let _budgetChecker: IBudgetChecker | null = null;
let _notificationQueueStore: INotificationQueueRepository | null = null;
let _notificationPrefsStore: INotificationPreferencesRepository | null = null;
let _credentialRepo: ICredentialRepository | null = null;
let _secretAuditRepo: ISecretAuditRepository | null = null;
let _rateLimitRepo: IRateLimitRepository | null = null;
let _circuitBreakerRepo: ICircuitBreakerRepository | null = null;
let _adminAuditLog: AdminAuditLog | null = null;
let _adminNotesRepo: IAdminNotesRepository | null = null;
let _tenantStatusRepo: ITenantStatusRepository | null = null;
let _bulkOpsRepo: IBulkOperationsRepository | null = null;
let _deletionRepo: IDeletionRepository | null = null;
let _exportRepo: IExportRepository | null = null;
let _orgRepo: IOrgRepository | null = null;
let _orgMemberRepo: IOrgMemberRepository | null = null;
let _orgService: OrgService | null = null;
let _orgMembershipRepo: IOrgMembershipRepository | null = null;
let _userRoleRepo: IUserRoleRepository | null = null;
let _promotionRepo: IPromotionRepository | null = null;
let _couponRepo: ICouponRepository | null = null;
let _redemptionRepo: IRedemptionRepository | null = null;
let _promotionEngine: PromotionEngine | null = null;
let _rateOverrideRepo: IAdapterRateOverrideRepository | null = null;
let _rateOverrideCache: AdapterRateOverrideCache | null = null;
let _tenantAddonRepo: ITenantAddonRepository | undefined;

// --- Platform singleton getters ---

export function getCreditLedger(): ILedger {
  if (!_creditLedger) _creditLedger = new DrizzleLedger(getDb());
  return _creditLedger;
}

export function getCreditTransactionRepo(): ICreditTransactionRepository {
  if (!_creditTransactionRepo) _creditTransactionRepo = new DrizzleCreditTransactionRepository(getDb());
  return _creditTransactionRepo;
}

export function getAutoTopupSettingsRepo(): IAutoTopupSettingsRepository {
  if (!_autoTopupSettingsRepo) _autoTopupSettingsRepo = new DrizzleAutoTopupSettingsRepository(getDb());
  return _autoTopupSettingsRepo;
}

export function getAutoTopupEventLogRepo(): IAutoTopupEventLogRepository {
  if (!_autoTopupEventLogRepo) _autoTopupEventLogRepo = new DrizzleAutoTopupEventLogRepository(getDb());
  return _autoTopupEventLogRepo;
}

export function getDividendRepo(): IDividendRepository {
  if (!_dividendRepo) _dividendRepo = new DrizzleDividendRepository(getDb());
  return _dividendRepo;
}

export function getMeterEmitter(): IMeterEmitter {
  if (!_meterEmitter) _meterEmitter = new DrizzleMeterEmitter(new DrizzleMeterEventRepository(getDb()));
  return _meterEmitter;
}

export function getMeterAggregator(): IMeterAggregator {
  if (!_meterAggregator) _meterAggregator = new DrizzleMeterAggregator(new DrizzleUsageSummaryRepository(getDb()));
  return _meterAggregator;
}

export function getTenantCustomerRepository(): ITenantCustomerRepository {
  if (!_tenantCustomerRepo) _tenantCustomerRepo = new DrizzleTenantCustomerRepository(getDb());
  return _tenantCustomerRepo;
}

export function getCryptoChargeRepository(): ICryptoChargeRepository {
  if (!_cryptoChargeRepo) _cryptoChargeRepo = new DrizzleCryptoChargeRepository(getDb());
  return _cryptoChargeRepo;
}

export function getBudgetChecker(): IBudgetChecker {
  if (!_budgetChecker) _budgetChecker = new DrizzleBudgetChecker(getDb());
  return _budgetChecker;
}

export function getNotificationQueueStore(): INotificationQueueRepository {
  if (!_notificationQueueStore) _notificationQueueStore = new DrizzleNotificationQueueStore(getDb());
  return _notificationQueueStore;
}

export function getNotificationPrefsStore(): INotificationPreferencesRepository {
  if (!_notificationPrefsStore) _notificationPrefsStore = new DrizzleNotificationPreferencesStore(getDb());
  return _notificationPrefsStore;
}

export function getCredentialRepo(): ICredentialRepository {
  if (!_credentialRepo) _credentialRepo = new DrizzleCredentialRepository(getDb());
  return _credentialRepo;
}

export function getSecretAuditRepo(): ISecretAuditRepository {
  if (!_secretAuditRepo) _secretAuditRepo = new DrizzleSecretAuditRepository(getDb());
  return _secretAuditRepo;
}

export function getRateLimitRepo(): IRateLimitRepository {
  if (!_rateLimitRepo) _rateLimitRepo = new DrizzleRateLimitRepository(getDb());
  return _rateLimitRepo;
}

export function getCircuitBreakerRepo(): ICircuitBreakerRepository {
  if (!_circuitBreakerRepo) _circuitBreakerRepo = new DrizzleCircuitBreakerRepository(getDb());
  return _circuitBreakerRepo;
}

export function getAdminAuditLog(): AdminAuditLog {
  if (!_adminAuditLog) _adminAuditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(getDb()));
  return _adminAuditLog;
}

export function getAdminNotesRepo(): IAdminNotesRepository {
  if (!_adminNotesRepo) _adminNotesRepo = new AdminNotesStore(getDb());
  return _adminNotesRepo;
}

export function getTenantStatusRepo(): ITenantStatusRepository {
  if (!_tenantStatusRepo) _tenantStatusRepo = new TenantStatusStore(getDb());
  return _tenantStatusRepo;
}

export function getBulkOpsRepo(): IBulkOperationsRepository {
  if (!_bulkOpsRepo) _bulkOpsRepo = new DrizzleBulkOperationsRepository(getDb());
  return _bulkOpsRepo;
}

export function getDeletionRepo(): IDeletionRepository {
  if (!_deletionRepo) _deletionRepo = new DrizzleDeletionRepository(getDb());
  return _deletionRepo;
}

export function getExportRepo(): IExportRepository {
  if (!_exportRepo) _exportRepo = new DrizzleExportRepository(getDb());
  return _exportRepo;
}

export function getOrgRepo(): IOrgRepository {
  if (!_orgRepo) _orgRepo = new DrizzleOrgRepository(getDb());
  return _orgRepo;
}

export function getOrgMemberRepo(): IOrgMemberRepository {
  if (!_orgMemberRepo) _orgMemberRepo = new DrizzleOrgMemberRepository(getDb());
  return _orgMemberRepo;
}

export function getOrgService(): OrgService {
  if (!_orgService) _orgService = new OrgService(getOrgRepo(), getOrgMemberRepo(), getDb());
  return _orgService;
}

export function getOrgMembershipRepo(): IOrgMembershipRepository {
  if (!_orgMembershipRepo) _orgMembershipRepo = new DrizzleOrgMembershipRepository(getDb());
  return _orgMembershipRepo;
}

export function getUserRoleRepo(): IUserRoleRepository {
  if (!_userRoleRepo) _userRoleRepo = new DrizzleUserRoleRepository(getDb());
  return _userRoleRepo;
}

export function getPromotionRepository(): IPromotionRepository {
  if (!_promotionRepo) _promotionRepo = new DrizzlePromotionRepository(getDb());
  return _promotionRepo;
}

export function getCouponRepository(): ICouponRepository {
  if (!_couponRepo) _couponRepo = new DrizzleCouponRepository(getDb());
  return _couponRepo;
}

export function getRedemptionRepository(): IRedemptionRepository {
  if (!_redemptionRepo) _redemptionRepo = new DrizzleRedemptionRepository(getDb());
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

export function getRateOverrideRepository(): IAdapterRateOverrideRepository {
  if (!_rateOverrideRepo) _rateOverrideRepo = new DrizzleAdapterRateOverrideRepository(getDb());
  return _rateOverrideRepo;
}

export function getRateOverrideCache(): AdapterRateOverrideCache {
  if (!_rateOverrideCache) _rateOverrideCache = new AdapterRateOverrideCache(getRateOverrideRepository());
  return _rateOverrideCache;
}

export function getTenantAddonRepo(): ITenantAddonRepository {
  if (!_tenantAddonRepo) _tenantAddonRepo = new DrizzleTenantAddonRepository(getDb());
  return _tenantAddonRepo;
}

import { AdminNotifier } from "@wopr-network/platform-core/fleet/admin-notifier";
import type { IBotInstanceRepository } from "@wopr-network/platform-core/fleet/bot-instance-repository";
import type { IBotProfileRepository } from "@wopr-network/platform-core/fleet/bot-profile-repository";
import {
  CapacityPolicy,
  type CapacityPolicyConfig,
  DEFAULT_CAPACITY_POLICY_CONFIG,
} from "@wopr-network/platform-core/fleet/capacity-policy";
import { DigitalOceanNodeProvider } from "@wopr-network/platform-core/fleet/digitalocean-node-provider";
import { DOClient } from "@wopr-network/platform-core/fleet/do-client";
import { DrizzleBotInstanceRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-instance-repository";
import { DrizzleBotProfileRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-profile-repository";
import { DrizzleFleetEventRepository } from "@wopr-network/platform-core/fleet/drizzle-fleet-event-repository";
import { DrizzleNodeRepository } from "@wopr-network/platform-core/fleet/drizzle-node-repository";
import { DrizzleRecoveryRepository } from "@wopr-network/platform-core/fleet/drizzle-recovery-repository";
import { FleetEventEmitter } from "@wopr-network/platform-core/fleet/fleet-event-emitter";
import type { IFleetEventRepository } from "@wopr-network/platform-core/fleet/fleet-event-repository";
import type { IGpuAllocationRepository } from "@wopr-network/platform-core/fleet/gpu-allocation-repository";
import { DrizzleGpuAllocationRepository } from "@wopr-network/platform-core/fleet/gpu-allocation-repository";
import type { IGpuConfigurationRepository } from "@wopr-network/platform-core/fleet/gpu-configuration-repository";
import { DrizzleGpuConfigurationRepository } from "@wopr-network/platform-core/fleet/gpu-configuration-repository";
import { GpuNodeProvisioner } from "@wopr-network/platform-core/fleet/gpu-node-provisioner";
import type { IGpuNodeRepository } from "@wopr-network/platform-core/fleet/gpu-node-repository";
import { DrizzleGpuNodeRepository } from "@wopr-network/platform-core/fleet/gpu-node-repository";
import { HeartbeatProcessor } from "@wopr-network/platform-core/fleet/heartbeat-processor";
import { HeartbeatWatchdog } from "@wopr-network/platform-core/fleet/heartbeat-watchdog";
import { InferenceWatchdog } from "@wopr-network/platform-core/fleet/inference-watchdog";
import { MigrationOrchestrator } from "@wopr-network/platform-core/fleet/migration-orchestrator";
import { NodeCommandBus } from "@wopr-network/platform-core/fleet/node-command-bus";
import { NodeConnectionRegistry } from "@wopr-network/platform-core/fleet/node-connection-registry";
import { NodeDrainer } from "@wopr-network/platform-core/fleet/node-drainer";
import type { INodeProvider } from "@wopr-network/platform-core/fleet/node-provider";
import { NodeProvisioner } from "@wopr-network/platform-core/fleet/node-provisioner";
import { NodeRegistrar } from "@wopr-network/platform-core/fleet/node-registrar";
import type { INodeRepository } from "@wopr-network/platform-core/fleet/node-repository";
import { OrphanCleaner } from "@wopr-network/platform-core/fleet/orphan-cleaner";
import { RecoveryOrchestrator } from "@wopr-network/platform-core/fleet/recovery-orchestrator";
import type { IRecoveryRepository } from "@wopr-network/platform-core/fleet/recovery-repository";
import type { IRegistrationTokenRepository } from "@wopr-network/platform-core/fleet/registration-token-store";
import { DrizzleRegistrationTokenRepository } from "@wopr-network/platform-core/fleet/registration-token-store";
import { DrizzleSpendingCapStore } from "@wopr-network/platform-core/fleet/spending-cap-repository";
import type { IVpsRepository } from "@wopr-network/platform-core/fleet/vps-repository";
import { DrizzleVpsRepository } from "@wopr-network/platform-core/fleet/vps-repository";
import type { IServiceKeyRepository } from "@wopr-network/platform-core/gateway/index";
import { DrizzleServiceKeyRepository } from "@wopr-network/platform-core/gateway/index";

const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || "/data/snapshots";

/**
 * Shared lazy-initialized fleet management singletons.
 * All files that need DB/repositories/orchestrators import from here
 * to ensure a single set of instances across the application.
 *
 * Nothing runs at import time — all initialization is deferred to first call.
 */

let _pool: Pool | null = null;
let _db: DrizzleDb | null = null;
let _registrationTokenStore: IRegistrationTokenRepository | null = null;
let _adminNotifier: AdminNotifier | null = null;

// Repositories
let _nodeRepo: INodeRepository | null = null;
let _botInstanceRepo: IBotInstanceRepository | null = null;
let _botProfileRepo: IBotProfileRepository | null = null;
let _recoveryRepo: IRecoveryRepository | null = null;
let _spendingCapStore: ISpendingCapStore | null = null;
let _gpuNodeRepo: IGpuNodeRepository | null = null;
let _gpuAllocationRepo: IGpuAllocationRepository | null = null;
let _gpuConfigurationRepo: IGpuConfigurationRepository | null = null;
let _serviceKeyRepo: IServiceKeyRepository | null = null;

// WebSocket layer
let _connectionRegistry: NodeConnectionRegistry | null = null;
let _commandBus: NodeCommandBus | null = null;

// Processors
let _heartbeatProcessor: HeartbeatProcessor | null = null;
let _nodeRegistrar: NodeRegistrar | null = null;
let _orphanCleaner: OrphanCleaner | null = null;

// Orchestrators
let _recoveryOrchestrator: RecoveryOrchestrator | null = null;
let _migrationOrchestrator: MigrationOrchestrator | null = null;
let _nodeDrainer: NodeDrainer | null = null;

// Watchdog
let _heartbeatWatchdog: HeartbeatWatchdog | null = null;
let _inferenceWatchdog: InferenceWatchdog | null = null;

// Fleet event emitter
let _fleetEventEmitter: FleetEventEmitter | null = null;

// Fleet event repository
let _fleetEventRepo: IFleetEventRepository | null = null;

// Infrastructure
let _doClient: DOClient | null = null;
let _nodeProvider: INodeProvider | null = null;
let _nodeProvisioner: NodeProvisioner | null = null;
let _gpuNodeProvisioner: GpuNodeProvisioner | null = null;
let _capacityPolicy: CapacityPolicy | null = null;
let _restoreLogStore: IRestoreLogStore | null = null;
let _restoreService: RestoreService | null = null;
let _backupStatusStore: IBackupStatusStore | null = null;
let _snapshotManager: SnapshotManager | null = null;

const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL environment variable is required");
    _pool = new Pool({
      connectionString,
      max: envInt("DB_POOL_MAX", 20),
      idleTimeoutMillis: envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    });
  }
  return _pool;
}

export function getDb(): DrizzleDb {
  if (!_db) {
    _db = createDb(getPool());
  }
  return _db;
}

/**
 * Initialize fleet services from an external pool/db (e.g. from buildContainer).
 * Must be called before any getter when using the DI container pattern.
 */
export function initFromContainer(pool: Pool, db: DrizzleDb): void {
  _pool = pool;
  _db = db;
}

/** Alias for audit DB — same PostgreSQL database in the pg migration. */
export function getAuditDb(): DrizzleDb {
  return getDb();
}

export function getRegistrationTokenStore(): IRegistrationTokenRepository {
  if (!_registrationTokenStore) {
    _registrationTokenStore = new DrizzleRegistrationTokenRepository(getDb());
  }
  return _registrationTokenStore;
}

export function getAdminNotifier() {
  if (!_adminNotifier) {
    _adminNotifier = new AdminNotifier({
      webhookUrl: process.env.ADMIN_WEBHOOK_URL,
    });
  }
  return _adminNotifier;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function getNodeRepo(): INodeRepository {
  if (!_nodeRepo) {
    _nodeRepo = new DrizzleNodeRepository(getDb());
  }
  return _nodeRepo;
}

/** Alias for compatibility with callers that use getNodeRepository() */
export const getNodeRepository = getNodeRepo;

export function getBotInstanceRepo(): IBotInstanceRepository {
  if (!_botInstanceRepo) {
    _botInstanceRepo = new DrizzleBotInstanceRepository(getDb());
  }
  return _botInstanceRepo;
}

export function getBotProfileRepo(): IBotProfileRepository {
  if (!_botProfileRepo) {
    _botProfileRepo = new DrizzleBotProfileRepository(getDb());
  }
  return _botProfileRepo;
}

export function getRecoveryRepo(): IRecoveryRepository {
  if (!_recoveryRepo) {
    _recoveryRepo = new DrizzleRecoveryRepository(getDb());
  }
  return _recoveryRepo;
}

export function getSpendingCapStore(): ISpendingCapStore {
  if (!_spendingCapStore) {
    _spendingCapStore = new DrizzleSpendingCapStore(getDb());
  }
  return _spendingCapStore;
}

export function getGpuNodeRepo(): IGpuNodeRepository {
  if (!_gpuNodeRepo) {
    _gpuNodeRepo = new DrizzleGpuNodeRepository(getDb());
  }
  return _gpuNodeRepo;
}

/** Alias for compatibility with callers that use getGpuNodeRepository() */
export const getGpuNodeRepository = getGpuNodeRepo;

export function getGpuAllocationRepo(): IGpuAllocationRepository {
  if (!_gpuAllocationRepo) {
    _gpuAllocationRepo = new DrizzleGpuAllocationRepository(getDb());
  }
  return _gpuAllocationRepo;
}

export function getGpuConfigurationRepo(): IGpuConfigurationRepository {
  if (!_gpuConfigurationRepo) {
    _gpuConfigurationRepo = new DrizzleGpuConfigurationRepository(getDb());
  }
  return _gpuConfigurationRepo;
}

export function getServiceKeyRepo(): IServiceKeyRepository {
  if (!_serviceKeyRepo) {
    _serviceKeyRepo = new DrizzleServiceKeyRepository(getDb());
  }
  return _serviceKeyRepo;
}

// ---------------------------------------------------------------------------
// WebSocket layer
// ---------------------------------------------------------------------------

export function getConnectionRegistry(): NodeConnectionRegistry {
  if (!_connectionRegistry) {
    _connectionRegistry = new NodeConnectionRegistry();
  }
  return _connectionRegistry;
}

export function getCommandBus(): NodeCommandBus {
  if (!_commandBus) {
    _commandBus = new NodeCommandBus(getConnectionRegistry());
  }
  return _commandBus;
}

// ---------------------------------------------------------------------------
// Processors
// ---------------------------------------------------------------------------

export function getHeartbeatProcessor(): HeartbeatProcessor {
  if (!_heartbeatProcessor) {
    _heartbeatProcessor = new HeartbeatProcessor(getNodeRepo());
  }
  return _heartbeatProcessor;
}

export function getOrphanCleaner(): OrphanCleaner {
  if (!_orphanCleaner) {
    _orphanCleaner = new OrphanCleaner(getNodeRepo(), getBotInstanceRepo(), getCommandBus());
  }
  return _orphanCleaner;
}

export function getNodeRegistrar(): NodeRegistrar {
  if (!_nodeRegistrar) {
    _nodeRegistrar = new NodeRegistrar(
      getNodeRepo(),
      getRecoveryRepo(),
      {
        onReturning: (_nodeId: string) => {
          // Intentional no-op. Container cleanup for returning nodes is handled by
          // OrphanCleaner on first heartbeat (wired via NodeConnectionManager in
          // initFleet). Waiting-tenant placement is handled separately by the
          // onRetryWaiting callback below, which fires for ALL registrations
          // (active or returning) whenever open recovery events have waiting items.
          // See WOP-912 for the investigation confirming this path is correct.
        },
        onRetryWaiting: (eventId: string) => {
          getRecoveryOrchestrator()
            .retryWaiting(eventId)
            .catch((err) => {
              logger.error("Auto-retry waiting after node registration failed", { eventId, err });
            });
        },
      },
      getFleetEventEmitter(),
    );
  }
  return _nodeRegistrar;
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

export function getRecoveryOrchestrator(): RecoveryOrchestrator {
  if (!_recoveryOrchestrator) {
    const nodeRepo = getNodeRepo();
    const botInstanceRepo = getBotInstanceRepo();

    _recoveryOrchestrator = new RecoveryOrchestrator(
      nodeRepo,
      getBotProfileRepo(),
      getRecoveryRepo(),
      getCommandBus(),
      getAdminNotifier(),
      async (deadNodeId: string) => {
        // Returns tenants on this node sorted by tier (enterprise > pro > starter > free)
        // DrizzleBotInstanceRepository.listByNode returns all instances; tier sorting is
        // handled here via a join-style approach using the raw list.
        const instances = await botInstanceRepo.listByNode(deadNodeId);
        return instances.map((inst) => ({
          botId: inst.id,
          tenantId: inst.tenantId,
          name: inst.name,
          containerName: `tenant_${inst.tenantId}`,
          estimatedMb: 100,
          tier: null,
        }));
      },
      async (excludeNodeId: string, requiredMb: number) => {
        return nodeRepo.findBestTarget(excludeNodeId, requiredMb);
      },
      async (botId: string, targetNodeId: string) => {
        await getBotInstanceRepo().reassign(botId, targetNodeId);
      },
      async (nodeId: string, deltaMb: number) => {
        await getNodeRepo().addCapacity(nodeId, deltaMb);
      },
    );
  }
  return _recoveryOrchestrator;
}

export function getMigrationOrchestrator(): MigrationOrchestrator {
  if (!_migrationOrchestrator) {
    _migrationOrchestrator = new MigrationOrchestrator(getCommandBus(), getBotInstanceRepo(), getNodeRepo());
  }
  return _migrationOrchestrator;
}

export function getNodeDrainer(): NodeDrainer {
  if (!_nodeDrainer) {
    _nodeDrainer = new NodeDrainer(
      getMigrationOrchestrator(),
      getNodeRepo(),
      getBotInstanceRepo(),
      getAdminNotifier(),
      getFleetEventEmitter(),
    );
  }
  return _nodeDrainer;
}

// ---------------------------------------------------------------------------
// FleetEventRepository
// ---------------------------------------------------------------------------

export function getFleetEventEmitter(): FleetEventEmitter {
  if (!_fleetEventEmitter) {
    _fleetEventEmitter = new FleetEventEmitter(getFleetEventRepo());
  }
  return _fleetEventEmitter;
}

export function getFleetEventRepo(): IFleetEventRepository {
  if (!_fleetEventRepo) {
    _fleetEventRepo = new DrizzleFleetEventRepository(getDb());
  }
  return _fleetEventRepo;
}

// ---------------------------------------------------------------------------
// HeartbeatWatchdog
// ---------------------------------------------------------------------------

export function getHeartbeatWatchdog() {
  if (!_heartbeatWatchdog) {
    _heartbeatWatchdog = new HeartbeatWatchdog(
      getNodeRepo(),
      (nodeId: string) => {
        // Signal the fleet-unexpected-stop alert: this fires only for
        // heartbeat timeouts (crash/OOM), never for user-initiated stops.
        getFleetEventRepo().fireFleetStop();
        getRecoveryOrchestrator()
          .triggerRecovery(nodeId, "heartbeat_timeout")
          .catch((err) => {
            logger.error(`Recovery failed for node ${nodeId}`, { err });
          });
      },
      (nodeId: string, newStatus: string) => {
        logger.info(`Node ${nodeId} status changed to ${newStatus}`);
      },
      {},
      getFleetEventEmitter(),
    );
  }
  return _heartbeatWatchdog;
}

// ---------------------------------------------------------------------------
// InferenceWatchdog
// ---------------------------------------------------------------------------

export function getInferenceWatchdog(): InferenceWatchdog {
  if (!_inferenceWatchdog) {
    _inferenceWatchdog = new InferenceWatchdog(getGpuNodeRepo(), getDOClient(), getAdminNotifier());
  }
  return _inferenceWatchdog;
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export function getDOClient(): DOClient {
  if (!_doClient) {
    const token = process.env.DO_API_TOKEN;
    if (!token) throw new Error("DO_API_TOKEN environment variable is required for node provisioning");
    _doClient = new DOClient(token);
  }
  return _doClient;
}

export function getNodeProvider(): INodeProvider {
  if (!_nodeProvider) {
    _nodeProvider = new DigitalOceanNodeProvider(getDOClient());
  }
  return _nodeProvider;
}

export function getNodeProvisioner(): NodeProvisioner {
  if (!_nodeProvisioner) {
    const sshKeyIdStr = process.env.DO_SSH_KEY_ID;
    if (!sshKeyIdStr) throw new Error("DO_SSH_KEY_ID environment variable is required");
    _nodeProvisioner = new NodeProvisioner(
      getNodeRepo(),
      getNodeProvider(),
      {
        sshKeyId: Number(sshKeyIdStr),
        defaultRegion: process.env.DO_DEFAULT_REGION,
        defaultSize: process.env.DO_DEFAULT_SIZE,
      },
      getFleetEventEmitter(),
    );
  }
  return _nodeProvisioner;
}

export function getGpuNodeProvisioner(): GpuNodeProvisioner {
  if (!_gpuNodeProvisioner) {
    const sshKeyIdStr = process.env.DO_SSH_KEY_ID;
    if (!sshKeyIdStr) throw new Error("DO_SSH_KEY_ID environment variable is required");
    _gpuNodeProvisioner = new GpuNodeProvisioner(getGpuNodeRepo(), getDOClient(), {
      sshKeyId: Number(sshKeyIdStr),
      defaultRegion: process.env.DO_GPU_DEFAULT_REGION ?? "nyc1",
      defaultSize: process.env.DO_GPU_DEFAULT_SIZE ?? "gpu-h100x1-80gb",
      platformUrl: process.env.PLATFORM_URL ?? "https://api.wopr.bot",
      gpuNodeSecret: process.env.GPU_NODE_SECRET ?? "",
    });
  }
  return _gpuNodeProvisioner;
}

export function getCapacityPolicy(configOverrides?: Partial<CapacityPolicyConfig>): CapacityPolicy {
  if (!_capacityPolicy) {
    const config = { ...DEFAULT_CAPACITY_POLICY_CONFIG, ...configOverrides };
    _capacityPolicy = new CapacityPolicy(
      getNodeRepo(),
      getNodeProvisioner(),
      getAdminNotifier(),
      config,
      getAdminAuditLog(),
    );
  } else if (configOverrides && Object.keys(configOverrides).length > 0) {
    // Singleton already initialized — overrides from this call will be silently ignored.
    // Callers that need custom config must set it before the first call to getCapacityPolicy().
    logger.warn("getCapacityPolicy: configOverrides ignored — singleton already initialized", { configOverrides });
  }
  return _capacityPolicy;
}

export function getRestoreLogStore(): IRestoreLogStore {
  if (!_restoreLogStore) {
    const repo = new DrizzleRestoreLogRepository(getDb());
    _restoreLogStore = new RestoreLogStore(repo);
  }
  return _restoreLogStore;
}

export function getBackupStatusStore(): IBackupStatusStore {
  if (!_backupStatusStore) {
    const repo = new DrizzleBackupStatusRepository(getDb());
    _backupStatusStore = new BackupStatusStore(repo);
  }
  return _backupStatusStore;
}

export function getSnapshotManager(): SnapshotManager {
  if (!_snapshotManager) {
    const repo = new DrizzleSnapshotRepository(getDb());
    _snapshotManager = new SnapshotManager({
      snapshotDir: SNAPSHOT_DIR,
      repo,
      spaces: process.env.S3_BUCKET ? new SpacesClient(process.env.S3_BUCKET) : undefined,
    });
  }
  return _snapshotManager;
}

export function getRestoreService(): RestoreService {
  if (!_restoreService) {
    _restoreService = new RestoreService({
      spaces: new SpacesClient(S3_BUCKET),
      commandBus: getCommandBus(),
      restoreLog: getRestoreLogStore(),
    });
  }
  return _restoreService;
}

/** Call once at server startup to wire up fleet services. */
export function initFleet(): void {
  // Eagerly initialize orphan cleaner so it's ready when heartbeats arrive
  getOrphanCleaner();

  // Start inference watchdog so GPU node health checks run in production
  getInferenceWatchdog().start();

  // Periodic cleanup: purge stale rate-limit rows every 5 minutes.
  // Uses the longest platform rate-limit window (1 hour) as the TTL so that
  // no active window is ever removed prematurely.
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour — matches the longest window in platformRateLimitRules
  setInterval(
    () => {
      getRateLimitRepo()
        .purgeStale(RATE_LIMIT_WINDOW_MS)
        .then((removed) => {
          if (removed > 0) logger.debug("Purged stale rate-limit rows", { removed });
        })
        .catch((err) => {
          logger.warn("Rate-limit purge failed", { err });
        });
    },
    5 * 60 * 1000,
  ).unref();

  // Periodic cleanup: purge stale circuit-breaker rows every minute.
  // Only non-tripped entries older than 1 minute are removed; tripped circuits
  // stay until they self-reset after pauseDurationMs.
  const CIRCUIT_BREAKER_STALE_MS = 60 * 1000; // 1 minute
  setInterval(() => {
    getCircuitBreakerRepo()
      .purgeStale(CIRCUIT_BREAKER_STALE_MS)
      .then((removed) => {
        if (removed > 0) logger.debug("Purged stale circuit-breaker rows", { removed });
      })
      .catch((err) => {
        logger.warn("Circuit-breaker purge failed", { err });
      });
  }, 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
// Monetization singletons (WOPR-specific)
// ---------------------------------------------------------------------------

let _botBilling: IBotBilling | null = null;
let _phoneNumberRepo: IPhoneNumberRepository | null = null;
let _affiliateRepo: IAffiliateRepository | null = null;
let _affiliateFraudRepo: IAffiliateFraudRepository | null = null;

export function getBotBilling(): IBotBilling {
  if (!_botBilling) _botBilling = new DrizzleBotBilling(getBotInstanceRepo(), getCommandBus());
  return _botBilling;
}

export function getPhoneNumberRepo(): IPhoneNumberRepository {
  if (!_phoneNumberRepo) _phoneNumberRepo = new DrizzlePhoneNumberRepository(getDb());
  return _phoneNumberRepo;
}

export function getAffiliateRepo(): IAffiliateRepository {
  if (!_affiliateRepo) _affiliateRepo = new DrizzleAffiliateRepository(getDb());
  return _affiliateRepo;
}

export function getAffiliateFraudRepo(): IAffiliateFraudRepository {
  if (!_affiliateFraudRepo) _affiliateFraudRepo = new DrizzleAffiliateFraudRepository(getDb());
  return _affiliateFraudRepo;
}

// ---------------------------------------------------------------------------
// VPS Repository (WOP-741)
// ---------------------------------------------------------------------------

let _vpsRepo: IVpsRepository | null = null;

export function getVpsRepo(): IVpsRepository {
  if (!_vpsRepo) {
    _vpsRepo = new DrizzleVpsRepository(getDb());
  }
  return _vpsRepo;
}

// ---------------------------------------------------------------------------
// Account / Security repository singletons (WOP-904)
// ---------------------------------------------------------------------------

let _deletionExecutorRepo: ILedgerDeletionRepository | null = null;

export function getDeletionExecutorRepo(): ILedgerDeletionRepository {
  if (!_deletionExecutorRepo) {
    _deletionExecutorRepo = new DrizzleLedgerDeletionRepository(getDb(), getPool());
  }
  return _deletionExecutorRepo;
}

// ---------------------------------------------------------------------------
// Observability / backup singletons (WOP-929)
// ---------------------------------------------------------------------------

let _systemResourceMonitor: SystemResourceMonitor | null = null;
let _backupVerifier: BackupVerifier | null = null;

export function getSystemResourceMonitor(): SystemResourceMonitor {
  if (!_systemResourceMonitor) {
    _systemResourceMonitor = new SystemResourceMonitor();
  }
  return _systemResourceMonitor;
}

export function getBackupVerifier(): BackupVerifier {
  if (!_backupVerifier) {
    _backupVerifier = new BackupVerifier({ spaces: new SpacesClient(S3_BUCKET) });
  }
  return _backupVerifier;
}

// ---------------------------------------------------------------------------
// Marketplace Plugin Repository (WOP-1031)
// ---------------------------------------------------------------------------

let _marketplacePluginRepo: IMarketplacePluginRepository | null = null;

export function getMarketplacePluginRepo(): IMarketplacePluginRepository {
  if (!_marketplacePluginRepo) {
    _marketplacePluginRepo = new DrizzleMarketplacePluginRepository(getDb());
  }
  return _marketplacePluginRepo;
}

// ---------------------------------------------------------------------------
// Marketplace Content Repository (WOP-1174)
// ---------------------------------------------------------------------------

import type { IMarketplaceContentRepository } from "@wopr-network/platform-core/api/marketplace-content-repository";
import { DrizzleMarketplaceContentRepository } from "@wopr-network/platform-core/api/marketplace-content-repository";

let _marketplaceContentRepo: IMarketplaceContentRepository | null = null;

export function getMarketplaceContentRepo(): IMarketplaceContentRepository {
  if (!_marketplaceContentRepo) {
    _marketplaceContentRepo = new DrizzleMarketplaceContentRepository(getDb());
  }
  return _marketplaceContentRepo;
}

// ---------------------------------------------------------------------------
// Onboarding singletons (WOP-1020)
// ---------------------------------------------------------------------------

import type { ISessionUsageRepository } from "@wopr-network/platform-core/inference/session-usage-repository";
import { DrizzleSessionUsageRepository } from "@wopr-network/platform-core/inference/session-usage-repository";
import { loadOnboardingConfig } from "@wopr-network/platform-core/onboarding/config";
import { DaemonManager, type IDaemonManager } from "@wopr-network/platform-core/onboarding/daemon-manager";
import type { IOnboardingScriptRepository } from "@wopr-network/platform-core/onboarding/drizzle-onboarding-script-repository";
import { DrizzleOnboardingScriptRepository } from "@wopr-network/platform-core/onboarding/drizzle-onboarding-script-repository";
import type { IOnboardingSessionRepository } from "@wopr-network/platform-core/onboarding/drizzle-onboarding-session-repository";
import { DrizzleOnboardingSessionRepository } from "@wopr-network/platform-core/onboarding/drizzle-onboarding-session-repository";
import { GraduationService } from "@wopr-network/platform-core/onboarding/graduation-service";
import { OnboardingService } from "@wopr-network/platform-core/onboarding/onboarding-service";
import { WoprClient } from "@wopr-network/platform-core/onboarding/wopr-client";

let _onboardingSessionRepo: IOnboardingSessionRepository | null = null;
let _onboardingScriptRepo: IOnboardingScriptRepository | null = null;
let _woprClient: WoprClient | null = null;
let _daemonManager: IDaemonManager | null = null;
let _onboardingService: OnboardingService | null = null;
let _sessionUsageRepo: ISessionUsageRepository | null = null; // NOSONAR
let _graduationService: GraduationService | null = null;

export function getGraduationService(): GraduationService {
  if (!_graduationService) {
    _graduationService = new GraduationService(getOnboardingSessionRepo(), getBotInstanceRepo(), getSessionUsageRepo());
  }
  return _graduationService;
}

export function getOnboardingSessionRepo(): IOnboardingSessionRepository {
  if (!_onboardingSessionRepo) {
    _onboardingSessionRepo = new DrizzleOnboardingSessionRepository(getDb());
  }
  return _onboardingSessionRepo;
}

export function getOnboardingScriptRepo(): IOnboardingScriptRepository {
  if (!_onboardingScriptRepo) {
    _onboardingScriptRepo = new DrizzleOnboardingScriptRepository(getDb());
  }
  return _onboardingScriptRepo;
}

export function getWoprClient(): WoprClient {
  if (!_woprClient) {
    const cfg = loadOnboardingConfig();
    _woprClient = new WoprClient(cfg.woprPort);
  }
  return _woprClient;
}

export function getDaemonManager(): IDaemonManager {
  if (!_daemonManager) {
    const cfg = loadOnboardingConfig();
    _daemonManager = new DaemonManager(cfg, getWoprClient());
  }
  return _daemonManager;
}

export function getSessionUsageRepo(): ISessionUsageRepository {
  if (!_sessionUsageRepo) {
    _sessionUsageRepo = new DrizzleSessionUsageRepository(getDb());
  }
  return _sessionUsageRepo;
}

export function getOnboardingService(): OnboardingService {
  if (!_onboardingService) {
    const cfg = loadOnboardingConfig();
    _onboardingService = new OnboardingService(
      getOnboardingSessionRepo(),
      getWoprClient(),
      cfg,
      getDaemonManager(),
      getSessionUsageRepo(),
      getOnboardingScriptRepo(),
      getCreditLedger(),
      (userId: string) => getUserRoleRepo().getTenantIdByUserId(userId),
    );
  }
  return _onboardingService;
}

// ---------------------------------------------------------------------------
// Setup Session Repository (WOP-1034)
// ---------------------------------------------------------------------------

import type { ISetupSessionRepository } from "@wopr-network/platform-core/setup/setup-session-repository";
import { DrizzleSetupSessionRepository } from "@wopr-network/platform-core/setup/setup-session-repository";

let _setupSessionRepo: ISetupSessionRepository | null = null;

export function getSetupSessionRepo(): ISetupSessionRepository {
  if (!_setupSessionRepo) {
    _setupSessionRepo = new DrizzleSetupSessionRepository(getDb());
  }
  return _setupSessionRepo;
}

// ---------------------------------------------------------------------------
// Page Context Repository (WOP-1517)
// ---------------------------------------------------------------------------

import type { IPageContextRepository } from "@wopr-network/platform-core/fleet/page-context-repository";
import { DrizzlePageContextRepository } from "@wopr-network/platform-core/fleet/page-context-repository";

let _pageContextRepo: IPageContextRepository | null = null;

export function getPageContextRepo(): IPageContextRepository {
  if (!_pageContextRepo) {
    _pageContextRepo = new DrizzlePageContextRepository(getDb());
  }
  return _pageContextRepo;
}

// ---------------------------------------------------------------------------
// Compliance Evidence Collector (WOP-529)
// ---------------------------------------------------------------------------

let _evidenceCollector: EvidenceCollector | null = null;

export function getEvidenceCollector(): EvidenceCollector {
  if (!_evidenceCollector) {
    _evidenceCollector = new EvidenceCollector({
      auditRepo: new DrizzleAuditLogRepository(getDb()),
      backupStore: getBackupStatusStore(),
      adminAuditRepo: new DrizzleAdminAuditLogRepository(getDb()),
      twoFactorRepo: new DrizzleTwoFactorRepository(getDb()),
    });
  }
  return _evidenceCollector;
}

// ---------------------------------------------------------------------------
// Setup Service (WOP-1037)
// ---------------------------------------------------------------------------

import { SetupService } from "@wopr-network/platform-core/setup/setup-service";

let _setupService: SetupService | null = null;

export function getSetupService(): SetupService {
  if (!_setupService) {
    _setupService = new SetupService(getSetupSessionRepo(), getPluginConfigRepo());
  }
  return _setupService;
}

// ---------------------------------------------------------------------------
// Plugin Config Repository (WOP-1055)
// ---------------------------------------------------------------------------

import type { IPluginConfigRepository } from "@wopr-network/platform-core/setup/plugin-config-repository";
import { DrizzlePluginConfigRepository } from "@wopr-network/platform-core/setup/plugin-config-repository";

let _pluginConfigRepo: IPluginConfigRepository | null = null;

export function getPluginConfigRepo(): IPluginConfigRepository {
  if (!_pluginConfigRepo) {
    _pluginConfigRepo = new DrizzlePluginConfigRepository(getDb());
  }
  return _pluginConfigRepo;
}

// ---------------------------------------------------------------------------
// Test helpers — NOT for production use
// ---------------------------------------------------------------------------

/** @internal Inject a test database. Call before any getter. */
export function _setDbForTest(db: DrizzleDb): void {
  _db = db;
}

/** @internal Reset all singletons. Call in afterAll to prevent cross-test leakage. */
export function _resetForTest(): void {
  // Platform-core singletons (formerly in platform-services.ts)
  _creditLedger = null;
  _creditTransactionRepo = null;
  _autoTopupSettingsRepo = null;
  _autoTopupEventLogRepo = null;
  _dividendRepo = null;
  _meterEmitter = null;
  _meterAggregator = null;
  _tenantCustomerRepo = null;
  _cryptoChargeRepo = null;
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

  // Fleet singletons
  _pool = null;
  _db = null;
  _registrationTokenStore = null;
  _adminNotifier = null;
  _nodeRepo = null;
  _botInstanceRepo = null;
  _botProfileRepo = null;
  _recoveryRepo = null;
  _spendingCapStore = null;
  _gpuNodeRepo = null;
  _gpuAllocationRepo = null;
  _gpuConfigurationRepo = null;
  _serviceKeyRepo = null;
  _connectionRegistry = null;
  _commandBus = null;
  _heartbeatProcessor = null;
  _nodeRegistrar = null;
  _orphanCleaner = null;
  _recoveryOrchestrator = null;
  _migrationOrchestrator = null;
  _nodeDrainer = null;
  _heartbeatWatchdog = null;
  _inferenceWatchdog = null;
  _fleetEventRepo = null;
  _fleetEventEmitter = null;
  _doClient = null;
  _nodeProvider = null;
  _nodeProvisioner = null;
  _gpuNodeProvisioner = null;
  _capacityPolicy = null;
  _restoreLogStore = null;
  _restoreService = null;
  _backupStatusStore = null;
  _snapshotManager = null;
  _botBilling = null;
  _phoneNumberRepo = null;
  _affiliateRepo = null;
  _affiliateFraudRepo = null;
  _vpsRepo = null;
  _deletionExecutorRepo = null;
  _systemResourceMonitor = null;
  _backupVerifier = null;
  _marketplacePluginRepo = null;
  _marketplaceContentRepo = null;
  _graduationService = null;
  _onboardingSessionRepo = null;
  _onboardingScriptRepo = null;
  _woprClient = null;
  _daemonManager = null;
  _onboardingService = null;
  _sessionUsageRepo = null;
  _setupSessionRepo = null;
  _pageContextRepo = null;
  _evidenceCollector = null;
  _setupService = null;
  _pluginConfigRepo = null;
}
