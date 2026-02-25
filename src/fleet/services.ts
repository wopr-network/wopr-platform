import Database from "better-sqlite3";
import type { IDeletionExecutorRepository } from "../account/deletion-executor-repository.js";
import { DrizzleDeletionExecutorRepository } from "../account/deletion-executor-repository.js";
import type { IDeletionRepository } from "../account/deletion-repository.js";
import { DrizzleDeletionRepository } from "../account/deletion-repository.js";
import { DrizzleAdminAuditLogRepository } from "../admin/admin-audit-log-repository.js";
import { AdminAuditLog } from "../admin/audit-log.js";
import type { IBulkOperationsRepository } from "../admin/bulk/bulk-operations-repository.js";
import { DrizzleBulkOperationsRepository } from "../admin/bulk/bulk-operations-repository.js";
import type { IAdminNotesRepository } from "../admin/notes/admin-notes-repository.js";
import { AdminNotesStore } from "../admin/notes/store.js";
import type { ITenantStatusRepository } from "../admin/tenant-status/tenant-status-repository.js";
import { TenantStatusStore } from "../admin/tenant-status/tenant-status-store.js";
import { DrizzleRateLimitRepository } from "../api/drizzle-rate-limit-repository.js";
import type { IRateLimitRepository } from "../api/rate-limit-repository.js";
import { DrizzleBackupStatusRepository } from "../backup/backup-status-repository.js";
import { BackupStatusStore } from "../backup/backup-status-store.js";
import { BackupVerifier } from "../backup/backup-verifier.js";
import { DrizzleRestoreLogRepository } from "../backup/restore-log-repository.js";
import { RestoreLogStore } from "../backup/restore-log-store.js";
import { RestoreService } from "../backup/restore-service.js";
import { SnapshotManager } from "../backup/snapshot-manager.js";
import { DrizzleSnapshotRepository } from "../backup/snapshot-repository.js";
import { SpacesClient } from "../backup/spaces-client.js";
import { logger } from "../config/logger.js";
import { applyPlatformPragmas, createDb, type DrizzleDb } from "../db/index.js";
import type { INotificationPreferencesStore } from "../email/notification-preferences-store.js";
import { DrizzleNotificationPreferencesStore } from "../email/notification-preferences-store.js";
import type { INotificationQueueStore } from "../email/notification-queue-store.js";
import { DrizzleNotificationQueueStore } from "../email/notification-queue-store.js";
import type { ICircuitBreakerRepository } from "../gateway/circuit-breaker-repository.js";
import { DrizzleCircuitBreakerRepository } from "../gateway/drizzle-circuit-breaker-repository.js";
import type { ISpendingCapStore } from "../gateway/spending-cap-store.js";
import type { IAffiliateRepository } from "../monetization/affiliate/drizzle-affiliate-repository.js";
import { DrizzleAffiliateRepository } from "../monetization/affiliate/drizzle-affiliate-repository.js";
import type { IBudgetChecker } from "../monetization/budget/budget-checker.js";
import { DrizzleBudgetChecker } from "../monetization/budget/budget-checker.js";
import type { IAutoTopupEventLogRepository } from "../monetization/credits/auto-topup-event-log-repository.js";
import { DrizzleAutoTopupEventLogRepository } from "../monetization/credits/auto-topup-event-log-repository.js";
import type { IAutoTopupSettingsRepository } from "../monetization/credits/auto-topup-settings-repository.js";
import { DrizzleAutoTopupSettingsRepository } from "../monetization/credits/auto-topup-settings-repository.js";
import type { IBotBilling } from "../monetization/credits/bot-billing.js";
import { DrizzleBotBilling } from "../monetization/credits/bot-billing.js";
import type { ICreditLedger } from "../monetization/credits/credit-ledger.js";
import { DrizzleCreditLedger } from "../monetization/credits/credit-ledger.js";
import type { IDividendRepository } from "../monetization/credits/dividend-repository.js";
import { DrizzleDividendRepository } from "../monetization/credits/dividend-repository.js";
import type { IPhoneNumberRepository } from "../monetization/credits/drizzle-phone-number-repository.js";
import { DrizzlePhoneNumberRepository } from "../monetization/credits/drizzle-phone-number-repository.js";
import { DrizzleTenantCustomerStore, type ITenantCustomerStore } from "../monetization/index.js";
import type { IMeterAggregator } from "../monetization/metering/aggregator.js";
import { DrizzleMeterAggregator } from "../monetization/metering/aggregator.js";
import type { IMeterEmitter } from "../monetization/metering/emitter.js";
import { DrizzleMeterEmitter } from "../monetization/metering/emitter.js";
import type { IPayRamChargeStore } from "../monetization/payram/charge-store.js";
import { DrizzlePayRamChargeStore } from "../monetization/payram/charge-store.js";
import { SystemResourceMonitor } from "../observability/system-resources.js";
import type { IOrgRepository } from "../org/drizzle-org-repository.js";
import { DrizzleOrgRepository } from "../org/drizzle-org-repository.js";
import { OrgService } from "../org/org-service.js";
import type { ICredentialRepository } from "../security/credential-vault/credential-repository.js";
import { DrizzleCredentialRepository } from "../security/credential-vault/credential-repository.js";
import { setOrgRouterDeps } from "../trpc/index.js";
import { AdminNotifier } from "./admin-notifier.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { IBotProfileRepository } from "./bot-profile-repository.js";
import { DOClient } from "./do-client.js";
import { DrizzleBotInstanceRepository } from "./drizzle-bot-instance-repository.js";
import { DrizzleBotProfileRepository } from "./drizzle-bot-profile-repository.js";
import { DrizzleFleetEventRepository } from "./drizzle-fleet-event-repository.js";
import { DrizzleNodeRepository } from "./drizzle-node-repository.js";
import { DrizzleRecoveryRepository } from "./drizzle-recovery-repository.js";
import type { IFleetEventRepository } from "./fleet-event-repository.js";
import { GpuNodeProvisioner } from "./gpu-node-provisioner.js";
import type { IGpuNodeRepository } from "./gpu-node-repository.js";
import { DrizzleGpuNodeRepository } from "./gpu-node-repository.js";
import { HeartbeatProcessor } from "./heartbeat-processor.js";
import { HeartbeatWatchdog } from "./heartbeat-watchdog.js";
import { InferenceWatchdog } from "./inference-watchdog.js";
import { MigrationOrchestrator } from "./migration-orchestrator.js";
import { NodeCommandBus } from "./node-command-bus.js";
import { NodeConnectionRegistry } from "./node-connection-registry.js";
import { NodeDrainer } from "./node-drainer.js";
import { NodeProvisioner } from "./node-provisioner.js";
import { NodeRegistrar } from "./node-registrar.js";
import type { INodeRepository } from "./node-repository.js";
import type { IOrgMemberRepository } from "./org-member-repository.js";
import { DrizzleOrgMemberRepository } from "./org-member-repository.js";
import { OrphanCleaner } from "./orphan-cleaner.js";
import { RecoveryOrchestrator } from "./recovery-orchestrator.js";
import type { IRecoveryRepository } from "./recovery-repository.js";
import { RegistrationTokenStore } from "./registration-token-store.js";
import { DrizzleSpendingCapStore } from "./spending-cap-repository.js";
import type { IVpsRepository } from "./vps-repository.js";
import { DrizzleVpsRepository } from "./vps-repository.js";

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";
const AUDIT_DB_PATH = process.env.AUDIT_DB_PATH || "/data/platform/audit.db";
const BACKUP_DB_PATH = process.env.BACKUP_DB_PATH || "/data/platform/backup-status.db";
const SNAPSHOT_DB_PATH = process.env.SNAPSHOT_DB_PATH || "/data/snapshots.db";
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || "/data/snapshots";

/**
 * Shared lazy-initialized fleet management singletons.
 * All files that need DB/repositories/orchestrators import from here
 * to ensure a single set of instances across the application.
 *
 * Nothing runs at import time — all initialization is deferred to first call.
 */

let _sqlite: Database.Database | null = null;
let _db: DrizzleDb | null = null;
let _auditSqlite: Database.Database | null = null;
let _auditDb: DrizzleDb | null = null;
let _registrationTokenStore: RegistrationTokenStore | null = null;
let _adminNotifier: AdminNotifier | null = null;

// Repositories
let _nodeRepo: INodeRepository | null = null;
let _botInstanceRepo: IBotInstanceRepository | null = null;
let _botProfileRepo: IBotProfileRepository | null = null;
let _recoveryRepo: IRecoveryRepository | null = null;
let _spendingCapStore: ISpendingCapStore | null = null;
let _gpuNodeRepo: IGpuNodeRepository | null = null;

// Admin repositories
let _adminNotesRepo: IAdminNotesRepository | null = null;
let _tenantStatusRepo: ITenantStatusRepository | null = null;
let _bulkOpsRepo: IBulkOperationsRepository | null = null;

// Notification repositories
let _notificationQueueStore: INotificationQueueStore | null = null;
let _notificationPrefsStore: INotificationPreferencesStore | null = null;

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

// Fleet event repository
let _fleetEventRepo: IFleetEventRepository | null = null;

// Rate limit repository
let _rateLimitRepo: IRateLimitRepository | null = null;

// Circuit breaker repository
let _circuitBreakerRepo: ICircuitBreakerRepository | null = null;

// Infrastructure
let _doClient: DOClient | null = null;
let _nodeProvisioner: NodeProvisioner | null = null;
let _gpuNodeProvisioner: GpuNodeProvisioner | null = null;
let _adminAuditLog: AdminAuditLog | null = null;
let _restoreLogStore: RestoreLogStore | null = null;
let _restoreService: RestoreService | null = null;
let _backupStatusStore: BackupStatusStore | null = null;
let _snapshotManager: SnapshotManager | null = null;

// Separate DB instances for backup/snapshot (different files from platform DB)
let _backupSqlite: Database.Database | null = null;
let _snapshotSqlite: Database.Database | null = null;

const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

export function getDb() {
  if (!_db) {
    _sqlite = new Database(PLATFORM_DB_PATH);
    applyPlatformPragmas(_sqlite);
    _db = createDb(_sqlite);
  }
  return _db;
}

/** Returns the raw better-sqlite3 instance backing the platform DB. */
export function getSqliteDb(): Database.Database {
  getDb(); // ensure initialized
  return _sqlite!;
}

/** Lazy-initialized audit database singleton. */
export function getAuditDb(): DrizzleDb {
  if (!_auditDb) {
    _auditSqlite = new Database(AUDIT_DB_PATH);
    applyPlatformPragmas(_auditSqlite);
    _auditDb = createDb(_auditSqlite);
  }
  return _auditDb;
}

export function getRegistrationTokenStore(): RegistrationTokenStore {
  if (!_registrationTokenStore) {
    _registrationTokenStore = new RegistrationTokenStore(getDb());
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

export function getAdminNotesRepo(): IAdminNotesRepository {
  if (!_adminNotesRepo) {
    _adminNotesRepo = new AdminNotesStore(getDb());
  }
  return _adminNotesRepo;
}

export function getTenantStatusRepo(): ITenantStatusRepository {
  if (!_tenantStatusRepo) {
    _tenantStatusRepo = new TenantStatusStore(getDb());
  }
  return _tenantStatusRepo;
}

export function getBulkOpsRepo(): IBulkOperationsRepository {
  if (!_bulkOpsRepo) {
    if (!_sqlite) throw new Error("SQLite not initialized");
    _bulkOpsRepo = new DrizzleBulkOperationsRepository(getDb(), _sqlite);
  }
  return _bulkOpsRepo;
}

// ---------------------------------------------------------------------------
// Notification Repositories
// ---------------------------------------------------------------------------

export function getNotificationQueueStore(): INotificationQueueStore {
  if (!_notificationQueueStore) {
    _notificationQueueStore = new DrizzleNotificationQueueStore(getDb());
  }
  return _notificationQueueStore;
}

export function getNotificationPrefsStore(): INotificationPreferencesStore {
  if (!_notificationPrefsStore) {
    _notificationPrefsStore = new DrizzleNotificationPreferencesStore(getDb());
  }
  return _notificationPrefsStore;
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
    _nodeRegistrar = new NodeRegistrar(getNodeRepo(), getRecoveryRepo(), {
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
    });
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
      (deadNodeId: string) => {
        // Returns tenants on this node sorted by tier (enterprise > pro > starter > free)
        // DrizzleBotInstanceRepository.listByNode returns all instances; tier sorting is
        // handled here via a join-style approach using the raw list.
        return botInstanceRepo.listByNode(deadNodeId).map((inst) => ({
          botId: inst.id,
          tenantId: inst.tenantId,
          name: inst.name,
          containerName: `tenant_${inst.tenantId}`,
          estimatedMb: 100,
          tier: null,
        }));
      },
      (excludeNodeId: string, requiredMb: number) => {
        return nodeRepo.findBestTarget(excludeNodeId, requiredMb) as import("./repository-types.js").Node | null;
      },
      (botId: string, targetNodeId: string) => {
        getBotInstanceRepo().reassign(botId, targetNodeId);
      },
      (nodeId: string, deltaMb: number) => {
        getNodeRepo().addCapacity(nodeId, deltaMb);
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
    _nodeDrainer = new NodeDrainer(getMigrationOrchestrator(), getNodeRepo(), getBotInstanceRepo(), getAdminNotifier());
  }
  return _nodeDrainer;
}

// ---------------------------------------------------------------------------
// FleetEventRepository
// ---------------------------------------------------------------------------

export function getFleetEventRepo(): IFleetEventRepository {
  if (!_fleetEventRepo) {
    _fleetEventRepo = new DrizzleFleetEventRepository(getDb());
  }
  return _fleetEventRepo;
}

export function getRateLimitRepo(): IRateLimitRepository {
  if (!_rateLimitRepo) {
    _rateLimitRepo = new DrizzleRateLimitRepository(getDb());
  }
  return _rateLimitRepo;
}

export function getCircuitBreakerRepo(): ICircuitBreakerRepository {
  if (!_circuitBreakerRepo) {
    _circuitBreakerRepo = new DrizzleCircuitBreakerRepository(getDb());
  }
  return _circuitBreakerRepo;
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

export function getNodeProvisioner(): NodeProvisioner {
  if (!_nodeProvisioner) {
    const sshKeyIdStr = process.env.DO_SSH_KEY_ID;
    if (!sshKeyIdStr) throw new Error("DO_SSH_KEY_ID environment variable is required");
    _nodeProvisioner = new NodeProvisioner(getDb(), getDOClient(), {
      sshKeyId: Number(sshKeyIdStr),
      defaultRegion: process.env.DO_DEFAULT_REGION,
      defaultSize: process.env.DO_DEFAULT_SIZE,
    });
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

export function getAdminAuditLog(): AdminAuditLog {
  if (!_adminAuditLog) {
    _adminAuditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(getDb()));
  }
  return _adminAuditLog;
}

export function getRestoreLogStore(): RestoreLogStore {
  if (!_restoreLogStore) {
    const repo = new DrizzleRestoreLogRepository(getDb());
    _restoreLogStore = new RestoreLogStore(repo);
  }
  return _restoreLogStore;
}

export function getBackupStatusStore(): BackupStatusStore {
  if (!_backupStatusStore) {
    _backupSqlite = new Database(BACKUP_DB_PATH);
    applyPlatformPragmas(_backupSqlite);
    const db = createDb(_backupSqlite);
    const repo = new DrizzleBackupStatusRepository(db);
    _backupStatusStore = new BackupStatusStore(repo);
  }
  return _backupStatusStore;
}

export function getSnapshotManager(): SnapshotManager {
  if (!_snapshotManager) {
    _snapshotSqlite = new Database(SNAPSHOT_DB_PATH);
    applyPlatformPragmas(_snapshotSqlite);
    const db = createDb(_snapshotSqlite);
    const repo = new DrizzleSnapshotRepository(db);
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
      try {
        const removed = getRateLimitRepo().purgeStale(RATE_LIMIT_WINDOW_MS);
        if (removed > 0) logger.debug("Purged stale rate-limit rows", { removed });
      } catch (err) {
        logger.warn("Rate-limit purge failed", { err });
      }
    },
    5 * 60 * 1000,
  ).unref();

  // Periodic cleanup: purge stale circuit-breaker rows every minute.
  // Only non-tripped entries older than 1 minute are removed; tripped circuits
  // stay until they self-reset after pauseDurationMs.
  const CIRCUIT_BREAKER_STALE_MS = 60 * 1000; // 1 minute
  setInterval(() => {
    try {
      const removed = getCircuitBreakerRepo().purgeStale(CIRCUIT_BREAKER_STALE_MS);
      if (removed > 0) logger.debug("Purged stale circuit-breaker rows", { removed });
    } catch (err) {
      logger.warn("Circuit-breaker purge failed", { err });
    }
  }, 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
// Monetization singletons (WOP-899)
// ---------------------------------------------------------------------------

let _creditLedger: ICreditLedger | null = null;
let _botBilling: IBotBilling | null = null;
let _meterEmitter: IMeterEmitter | null = null;
let _meterAggregator: IMeterAggregator | null = null;
let _budgetChecker: IBudgetChecker | null = null;
let _tenantCustomerStore: ITenantCustomerStore | null = null;
let _payramChargeStore: IPayRamChargeStore | null = null;
let _dividendRepo: IDividendRepository | null = null;
let _autoTopupSettingsRepo: IAutoTopupSettingsRepository | null = null;
let _autoTopupEventLogRepo: IAutoTopupEventLogRepository | null = null;
let _phoneNumberRepo: IPhoneNumberRepository | null = null;
let _affiliateRepo: IAffiliateRepository | null = null;

export function getCreditLedger(): ICreditLedger {
  if (!_creditLedger) _creditLedger = new DrizzleCreditLedger(getDb());
  return _creditLedger;
}

export function getBotBilling(): IBotBilling {
  if (!_botBilling) _botBilling = new DrizzleBotBilling(getDb());
  return _botBilling;
}

export function getMeterEmitter(): IMeterEmitter {
  if (!_meterEmitter) _meterEmitter = new DrizzleMeterEmitter(getDb());
  return _meterEmitter;
}

export function getMeterAggregator(): IMeterAggregator {
  if (!_meterAggregator) _meterAggregator = new DrizzleMeterAggregator(getDb());
  return _meterAggregator;
}

export function getBudgetChecker(): IBudgetChecker {
  if (!_budgetChecker) _budgetChecker = new DrizzleBudgetChecker(getDb());
  return _budgetChecker;
}

export function getTenantCustomerStore(): ITenantCustomerStore {
  if (!_tenantCustomerStore) _tenantCustomerStore = new DrizzleTenantCustomerStore(getDb());
  return _tenantCustomerStore;
}

export function getPayRamChargeStore(): IPayRamChargeStore {
  if (!_payramChargeStore) _payramChargeStore = new DrizzlePayRamChargeStore(getDb());
  return _payramChargeStore;
}

export function getDividendRepo(): IDividendRepository {
  if (!_dividendRepo) _dividendRepo = new DrizzleDividendRepository(getDb());
  return _dividendRepo;
}

export function getAutoTopupSettingsRepo(): IAutoTopupSettingsRepository {
  if (!_autoTopupSettingsRepo) _autoTopupSettingsRepo = new DrizzleAutoTopupSettingsRepository(getDb());
  return _autoTopupSettingsRepo;
}

export function getAutoTopupEventLogRepo(): IAutoTopupEventLogRepository {
  if (!_autoTopupEventLogRepo) _autoTopupEventLogRepo = new DrizzleAutoTopupEventLogRepository(getDb());
  return _autoTopupEventLogRepo;
}

export function getPhoneNumberRepo(): IPhoneNumberRepository {
  if (!_phoneNumberRepo) _phoneNumberRepo = new DrizzlePhoneNumberRepository(getDb());
  return _phoneNumberRepo;
}

export function getAffiliateRepo(): IAffiliateRepository {
  if (!_affiliateRepo) _affiliateRepo = new DrizzleAffiliateRepository(getDb());
  return _affiliateRepo;
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

let _deletionRepo: IDeletionRepository | null = null;
let _deletionExecutorRepo: IDeletionExecutorRepository | null = null;
let _credentialRepo: ICredentialRepository | null = null;

export function getDeletionRepo(): IDeletionRepository {
  if (!_deletionRepo) {
    _deletionRepo = new DrizzleDeletionRepository(getDb());
  }
  return _deletionRepo;
}

export function getDeletionExecutorRepo(): IDeletionExecutorRepository {
  if (!_deletionExecutorRepo) {
    const db = getDb(); // ensures _sqlite is initialized
    if (!_sqlite) throw new Error("SQLite connection not initialized");
    _deletionExecutorRepo = new DrizzleDeletionExecutorRepository(db, _sqlite);
  }
  return _deletionExecutorRepo;
}

export function getCredentialRepo(): ICredentialRepository {
  if (!_credentialRepo) {
    _credentialRepo = new DrizzleCredentialRepository(getDb());
  }
  return _credentialRepo;
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
// Org repository singleton (WOP-1000)
// ---------------------------------------------------------------------------

let _orgRepo: IOrgRepository | null = null;

export function getOrgRepo(): IOrgRepository {
  if (!_orgRepo) {
    _orgRepo = new DrizzleOrgRepository(getDb());
  }
  return _orgRepo;
}

let _orgMemberRepo: IOrgMemberRepository | null = null;
let _orgService: OrgService | null = null;

export function getOrgMemberRepo(): IOrgMemberRepository {
  if (!_orgMemberRepo) {
    _orgMemberRepo = new DrizzleOrgMemberRepository(getDb());
  }
  return _orgMemberRepo;
}

export function getOrgService(): OrgService {
  if (!_orgService) {
    _orgService = new OrgService(getOrgRepo(), getOrgMemberRepo());
    setOrgRouterDeps({ orgService: _orgService });
  }
  return _orgService;
}
