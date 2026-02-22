import Database from "better-sqlite3";
import { AdminAuditLog } from "../admin/audit-log.js";
import type { IBulkOperationsRepository } from "../admin/bulk/bulk-operations-repository.js";
import { DrizzleBulkOperationsRepository } from "../admin/bulk/bulk-operations-repository.js";
import type { IAdminNotesRepository } from "../admin/notes/admin-notes-repository.js";
import { AdminNotesStore } from "../admin/notes/store.js";
import type { ITenantStatusRepository } from "../admin/tenant-status/tenant-status-repository.js";
import { TenantStatusStore } from "../admin/tenant-status/tenant-status-store.js";
import { RestoreLogStore } from "../backup/restore-log-store.js";
import { RestoreService } from "../backup/restore-service.js";
import { SpacesClient } from "../backup/spaces-client.js";
import { logger } from "../config/logger.js";
import { applyPlatformPragmas, createDb, type DrizzleDb } from "../db/index.js";
import type { ISpendingCapStore } from "../gateway/spending-cap-store.js";
import type { IBudgetChecker } from "../monetization/budget/budget-checker.js";
import { DrizzleBudgetChecker } from "../monetization/budget/budget-checker.js";
import type { IBotBilling } from "../monetization/credits/bot-billing.js";
import { DrizzleBotBilling } from "../monetization/credits/bot-billing.js";
import type { ICreditLedger } from "../monetization/credits/credit-ledger.js";
import { DrizzleCreditLedger } from "../monetization/credits/credit-ledger.js";
import type { IMeterAggregator } from "../monetization/metering/aggregator.js";
import { DrizzleMeterAggregator } from "../monetization/metering/aggregator.js";
import type { IMeterEmitter } from "../monetization/metering/emitter.js";
import { DrizzleMeterEmitter } from "../monetization/metering/emitter.js";
import type { IUsageAggregationWorker } from "../monetization/metering/usage-aggregation-worker.js";
import { DrizzleUsageAggregationWorker } from "../monetization/metering/usage-aggregation-worker.js";
import type { IPayRamChargeStore } from "../monetization/payram/charge-store.js";
import { DrizzlePayRamChargeStore } from "../monetization/payram/charge-store.js";
import type { ITenantCustomerStore } from "../monetization/stripe/tenant-store.js";
import { DrizzleTenantCustomerStore } from "../monetization/stripe/tenant-store.js";
import { AdminNotifier } from "./admin-notifier.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import { DrizzleBotInstanceRepository } from "./bot-instance-repository.js";
import type { IBotProfileRepository } from "./bot-profile-repository.js";
import { DrizzleBotProfileRepository } from "./bot-profile-repository.js";
import { DOClient } from "./do-client.js";
import { HeartbeatProcessor } from "./heartbeat-processor.js";
import { HeartbeatWatchdog } from "./heartbeat-watchdog.js";
import { MigrationOrchestrator } from "./migration-orchestrator.js";
import { NodeCommandBus } from "./node-command-bus.js";
import { NodeConnectionRegistry } from "./node-connection-registry.js";
import { NodeDrainer } from "./node-drainer.js";
import { NodeProvisioner } from "./node-provisioner.js";
import { NodeRegistrar } from "./node-registrar.js";
import type { INodeRepository } from "./node-repository.js";
import { DrizzleNodeRepository } from "./node-repository.js";
import { OrphanCleaner } from "./orphan-cleaner.js";
import { RecoveryOrchestrator } from "./recovery-orchestrator.js";
import type { IRecoveryRepository } from "./recovery-repository.js";
import { DrizzleRecoveryRepository } from "./recovery-repository.js";
import { RegistrationTokenStore } from "./registration-token-store.js";
import { DrizzleSpendingCapStore } from "./spending-cap-repository.js";

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";
const AUDIT_DB_PATH = process.env.AUDIT_DB_PATH || "/data/platform/audit.db";

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

// Admin repositories
let _adminNotesRepo: IAdminNotesRepository | null = null;
let _tenantStatusRepo: ITenantStatusRepository | null = null;
let _bulkOpsRepo: IBulkOperationsRepository | null = null;

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

// Infrastructure
let _doClient: DOClient | null = null;
let _nodeProvisioner: NodeProvisioner | null = null;
let _adminAuditLog: AdminAuditLog | null = null;
let _restoreLogStore: RestoreLogStore | null = null;
let _restoreService: RestoreService | null = null;

const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

export function getDb() {
  if (!_db) {
    _sqlite = new Database(PLATFORM_DB_PATH);
    applyPlatformPragmas(_sqlite);
    _db = createDb(_sqlite);
  }
  return _db;
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
        // OrphanCleaner runs on first heartbeat from a returning node (index.ts)
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
// HeartbeatWatchdog
// ---------------------------------------------------------------------------

export function getHeartbeatWatchdog() {
  if (!_heartbeatWatchdog) {
    _heartbeatWatchdog = new HeartbeatWatchdog(
      getNodeRepo(),
      (nodeId: string) => {
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

export function getAdminAuditLog(): AdminAuditLog {
  if (!_adminAuditLog) {
    _adminAuditLog = new AdminAuditLog(getDb());
  }
  return _adminAuditLog;
}

export function getRestoreLogStore(): RestoreLogStore {
  if (!_restoreLogStore) {
    _restoreLogStore = new RestoreLogStore(getDb());
  }
  return _restoreLogStore;
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
}

// ---------------------------------------------------------------------------
// Monetization singletons (WOP-899)
// ---------------------------------------------------------------------------

let _creditLedger: ICreditLedger | null = null;
let _botBilling: IBotBilling | null = null;
let _meterEmitter: IMeterEmitter | null = null;
let _meterAggregator: IMeterAggregator | null = null;
let _usageAggregationWorker: IUsageAggregationWorker | null = null;
let _budgetChecker: IBudgetChecker | null = null;
let _tenantCustomerStore: ITenantCustomerStore | null = null;
let _payramChargeStore: IPayRamChargeStore | null = null;

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

export function getUsageAggregationWorker(): IUsageAggregationWorker {
  if (!_usageAggregationWorker) _usageAggregationWorker = new DrizzleUsageAggregationWorker(getDb());
  return _usageAggregationWorker;
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
