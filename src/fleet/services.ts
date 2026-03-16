import { DrizzleAdminAuditLogRepository } from "@wopr-network/platform-core/admin";
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
// Platform singletons — delegated to platform-services.ts
import {
  _initPlatformServices,
  _resetPlatformForTest,
  getAdminAuditLog,
  getAdminNotesRepo,
  getAutoTopupEventLogRepo,
  getAutoTopupSettingsRepo,
  getBudgetChecker,
  getBulkOpsRepo,
  getCircuitBreakerRepo,
  getCouponRepository,
  getCredentialRepo,
  getCreditLedger,
  getCreditTransactionRepo,
  getDeletionRepo,
  getDividendRepo,
  getExportRepo,
  getMeterAggregator,
  getMeterEmitter,
  getNotificationPrefsStore,
  getNotificationQueueStore,
  getOrgMemberRepo,
  getOrgMembershipRepo,
  getOrgRepo,
  getOrgService,
  getPayRamChargeRepository,
  getPromotionEngine,
  getPromotionRepository,
  getRateLimitRepo,
  getRateOverrideCache,
  getRateOverrideRepository,
  getRedemptionRepository,
  getSecretAuditRepo,
  getTenantAddonRepo,
  getTenantCustomerRepository,
  getTenantStatusRepo,
  getUserRoleRepo,
} from "../platform-services.js";

// Re-export all platform singletons so existing consumers keep working
export {
  getAdminAuditLog,
  getAdminNotesRepo,
  getAutoTopupEventLogRepo,
  getAutoTopupSettingsRepo,
  getBudgetChecker,
  getBulkOpsRepo,
  getCircuitBreakerRepo,
  getCouponRepository,
  getCredentialRepo,
  getCreditLedger,
  getCreditTransactionRepo,
  getDeletionRepo,
  getDividendRepo,
  getExportRepo,
  getMeterAggregator,
  getMeterEmitter,
  getNotificationPrefsStore,
  getNotificationQueueStore,
  getOrgMemberRepo,
  getOrgMembershipRepo,
  getOrgRepo,
  getOrgService,
  getPayRamChargeRepository,
  getPromotionEngine,
  getPromotionRepository,
  getRateLimitRepo,
  getRateOverrideCache,
  getRateOverrideRepository,
  getRedemptionRepository,
  getSecretAuditRepo,
  getTenantAddonRepo,
  getTenantCustomerRepository,
  getTenantStatusRepo,
  getUserRoleRepo,
};

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
    _initPlatformServices(getDb);
  }
  return _db;
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
  _initPlatformServices(() => db);
}

/** @internal Reset all singletons. Call in afterAll to prevent cross-test leakage. */
export function _resetForTest(): void {
  _resetPlatformForTest();
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
