import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { AdminAuditLog } from "../admin/audit-log.js";
import { RestoreLogStore } from "../backup/restore-log-store.js";
import { RestoreService } from "../backup/restore-service.js";
import { SpacesClient } from "../backup/spaces-client.js";
import { logger } from "../config/logger.js";
import { applyPlatformPragmas } from "../db/pragmas.js";
import * as dbSchema from "../db/schema/index.js";
import { AdminNotifier } from "./admin-notifier.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import { DrizzleBotInstanceRepository } from "./bot-instance-repository.js";
import type { IBotProfileRepository } from "./bot-profile-repository.js";
import { DrizzleBotProfileRepository } from "./bot-profile-repository.js";
import { DOClient } from "./do-client.js";
import { HeartbeatProcessor } from "./heartbeat-processor.js";
import { HeartbeatWatchdog } from "./heartbeat-watchdog.js";
import { MigrationManager } from "./migration-manager.js";
import { MigrationOrchestrator } from "./migration-orchestrator.js";
import { NodeCommandBus } from "./node-command-bus.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
import { NodeConnectionRegistry } from "./node-connection-registry.js";
import { NodeDrainer } from "./node-drainer.js";
import { NodeProvisioner } from "./node-provisioner.js";
import { NodeRegistrar } from "./node-registrar.js";
import type { INodeRepository } from "./node-repository.js";
import { DrizzleNodeRepository } from "./node-repository.js";
import { OrphanCleaner } from "./orphan-cleaner.js";
import { RecoveryManager } from "./recovery-manager.js";
import type { IRecoveryRepository } from "./recovery-orchestrator.js";
import { RecoveryOrchestrator } from "./recovery-orchestrator.js";
import { RegistrationTokenStore } from "./registration-token-store.js";

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";

/**
 * Shared lazy-initialized fleet management singletons.
 * All files that need DB/repositories/orchestrators import from here
 * to ensure a single set of instances across the application.
 *
 * Nothing runs at import time — all initialization is deferred to first call.
 */

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle<typeof dbSchema>> | null = null;
// --- Legacy singletons (kept until HeartbeatWatchdog + OrphanCleaner are updated) ---
// TODO: WOP-873 — remove _nodeConnections once HeartbeatWatchdog uses RecoveryOrchestrator
let _nodeConnections: NodeConnectionManager | null = null;
// TODO: WOP-873 — remove _recoveryManager once HeartbeatWatchdog uses RecoveryOrchestrator
let _recoveryManager: RecoveryManager | null = null;
// --- New repository singletons ---
let _nodeRepo: INodeRepository | null = null;
let _botProfileRepo: IBotProfileRepository | null = null;
let _botInstanceRepo: IBotInstanceRepository | null = null;
// TODO: WOP-867 — add _recoveryRepo once DrizzleRecoveryRepository is available
// biome-ignore lint/style/useConst: WOP-867 will assign this once DrizzleRecoveryRepository is available
let _recoveryRepo: IRecoveryRepository | null = null;
// --- WebSocket layer singletons ---
let _connectionRegistry: NodeConnectionRegistry | null = null;
let _commandBus: NodeCommandBus | null = null;
// --- Processor singletons ---
let _heartbeatProcessor: HeartbeatProcessor | null = null;
// --- Orchestrator singletons ---
let _recoveryOrchestrator: RecoveryOrchestrator | null = null;
let _nodeRegistrar: NodeRegistrar | null = null;
let _orphanCleaner: OrphanCleaner | null = null;
let _migrationOrchestrator: MigrationOrchestrator | null = null;
let _nodeDrainer: NodeDrainer | null = null;
// --- Legacy migration manager (kept until all callers migrated) ---
// TODO: WOP-881 — remove _migrationManager once all callers use getMigrationOrchestrator()
let _migrationManager: MigrationManager | null = null;
// --- Other singletons ---
let _registrationTokenStore: RegistrationTokenStore | null = null;
let _adminNotifier: AdminNotifier | null = null;
let _heartbeatWatchdog: HeartbeatWatchdog | null = null;

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
    _db = drizzle(_sqlite, { schema: dbSchema });
  }
  return _db;
}

// --- Legacy: kept until HeartbeatWatchdog (WOP-873) and OrphanCleaner are updated ---

/** @deprecated Use getConnectionRegistry() + getCommandBus() instead. Remove in WOP-873. */
export function getNodeConnections() {
  if (!_nodeConnections) {
    _nodeConnections = new NodeConnectionManager(getDb(), {
      onNodeRegistered: () => {
        // Fire-and-forget: check for waiting recovery tenants when new capacity is available
        getRecoveryManager()
          .checkAndRetryWaiting()
          .catch((err) => {
            logger.error("Auto-retry after node registration failed", { err });
          });
      },
    });
  }
  return _nodeConnections;
}

/** @deprecated Use getRecoveryOrchestrator() instead. Remove in WOP-873. */
export function getRecoveryManager() {
  if (!_recoveryManager) {
    _recoveryManager = new RecoveryManager(getDb(), getNodeConnections(), getAdminNotifier());
  }
  return _recoveryManager;
}

// --- Repositories ---

export function getNodeRepo(): INodeRepository {
  if (!_nodeRepo) {
    _nodeRepo = new DrizzleNodeRepository(getDb());
  }
  return _nodeRepo;
}

export function getBotProfileRepo(): IBotProfileRepository {
  if (!_botProfileRepo) {
    _botProfileRepo = new DrizzleBotProfileRepository(getDb());
  }
  return _botProfileRepo;
}

export function getBotInstanceRepo(): IBotInstanceRepository {
  if (!_botInstanceRepo) {
    _botInstanceRepo = new DrizzleBotInstanceRepository(getDb());
  }
  return _botInstanceRepo;
}

// TODO: WOP-867 — uncomment once DrizzleRecoveryRepository is available
// import { DrizzleRecoveryRepository } from "./recovery-repository.js";
// export function getRecoveryRepo(): IRecoveryRepository {
//   if (!_recoveryRepo) {
//     _recoveryRepo = new DrizzleRecoveryRepository(getDb());
//   }
//   return _recoveryRepo;
// }

// --- WebSocket layer ---

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

// --- Processors ---

export function getHeartbeatProcessor(): HeartbeatProcessor {
  if (!_heartbeatProcessor) {
    _heartbeatProcessor = new HeartbeatProcessor(getNodeRepo());
  }
  return _heartbeatProcessor;
}

// --- Orchestrators ---

export function getRecoveryOrchestrator(): RecoveryOrchestrator {
  if (!_recoveryOrchestrator) {
    // TODO: WOP-867 — replace getRecoveryRepo() stub with real DrizzleRecoveryRepository
    if (!_recoveryRepo) {
      throw new Error(
        "getRecoveryOrchestrator() requires IRecoveryRepository which depends on WOP-867 (DrizzleRecoveryRepository). Merge WOP-867 first.",
      );
    }
    _recoveryOrchestrator = new RecoveryOrchestrator(
      // DrizzleNodeRepository satisfies INodeRepository at runtime; status widening requires cast
      getNodeRepo() as unknown as import("./recovery-orchestrator.js").INodeRepository,
      getBotProfileRepo(),
      _recoveryRepo,
      getCommandBus(),
      getAdminNotifier(),
      (nodeId: string) => {
        // getTenants: list all bot instances on this node as TenantRecoveryInfo.
        // estimatedMb defaults to 100 per tenant; actual profile size not tracked yet.
        return getBotInstanceRepo()
          .listByNode(nodeId)
          .map((b) => ({
            botId: b.id,
            tenantId: b.tenantId,
            name: b.name,
            containerName: `tenant_${b.tenantId}`,
            estimatedMb: 100,
            tier: null,
          }));
      },
      (excludeNodeId: string, requiredMb: number) => {
        // DrizzleNodeRepository.Node has status: string; cast to repository-types.Node at runtime-safe
        const result = (getNodeRepo() as DrizzleNodeRepository).findBestTarget(excludeNodeId, requiredMb);
        return result as unknown as import("./repository-types.js").Node | null;
      },
      (botId: string, targetNodeId: string) => {
        getBotInstanceRepo().reassign(botId, targetNodeId);
      },
      (nodeId: string, deltaMb: number) => {
        (getNodeRepo() as DrizzleNodeRepository).addCapacity(nodeId, deltaMb);
      },
    );
  }
  return _recoveryOrchestrator;
}

export function getNodeRegistrar(): NodeRegistrar {
  if (!_nodeRegistrar) {
    // TODO: WOP-867 — replace stub with real getRecoveryRepo()
    if (!_recoveryRepo) {
      throw new Error(
        "getNodeRegistrar() requires IRecoveryRepository which depends on WOP-867 (DrizzleRecoveryRepository). Merge WOP-867 first.",
      );
    }
    _nodeRegistrar = new NodeRegistrar(
      // DrizzleNodeRepository satisfies NodeRegistrarNodeRepo at runtime; status widening requires cast
      getNodeRepo() as unknown as import("./node-registrar.js").NodeRegistrarNodeRepo,
      _recoveryRepo,
      {
        onReturning: (_nodeId: string) => {
          // OrphanCleaner handles returning nodes — schedules cleanup.
          // The actual container list comes from the first heartbeat;
          // OrphanCleaner.clean() will be called from the WS message handler (WOP-880).
        },
        onRetryWaiting: (eventId: string) => {
          getRecoveryOrchestrator()
            .retryWaiting(eventId)
            .catch((err) => {
              logger.error(`Auto-retry failed for recovery event ${eventId}`, { err });
            });
        },
      },
    );
  }
  return _nodeRegistrar;
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

// --- OrphanCleaner: kept using old deps until WOP-872 update is complete ---
// TODO: WOP-881 — update OrphanCleaner to use IBotInstanceRepository + INodeCommandBus

export function getOrphanCleaner(): OrphanCleaner {
  if (!_orphanCleaner) {
    _orphanCleaner = new OrphanCleaner(getDb(), getNodeConnections());
    // Complete the bidirectional link: NCM needs OrphanCleaner to trigger cleanup on heartbeat
    getNodeConnections().setOrphanCleaner(_orphanCleaner);
  }
  return _orphanCleaner;
}

/** Call once at server startup to wire up OrphanCleaner into NodeConnectionManager. */
export function initFleet(): void {
  getOrphanCleaner();
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

export function getHeartbeatWatchdog() {
  if (!_heartbeatWatchdog) {
    // TODO: WOP-873 — update HeartbeatWatchdog to accept RecoveryOrchestrator, then use:
    //   _heartbeatWatchdog = new HeartbeatWatchdog(getNodeRepo(), getRecoveryOrchestrator(), ...)
    _heartbeatWatchdog = new HeartbeatWatchdog(
      // DrizzleNodeRepository satisfies INodeRepository at runtime; status widening requires cast
      getNodeRepo() as unknown as import("./repository-types.js").INodeRepository,
      getRecoveryManager(),
      (nodeId: string, newStatus: string) => {
        logger.info(`Node ${nodeId} status changed to ${newStatus}`);
      },
    );
  }
  return _heartbeatWatchdog;
}

/** @deprecated Use getMigrationOrchestrator() instead. Will be removed in WOP-881. */
export function getMigrationManager() {
  if (!_migrationManager) {
    _migrationManager = new MigrationManager(getDb(), getNodeConnections(), getAdminNotifier());
  }
  return _migrationManager;
}

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
    // RestoreService still expects NodeConnectionManager shape.
    // Create a thin adapter that delegates sendCommand to NodeCommandBus.
    const commandAdapter = {
      sendCommand: (nodeId: string, command: { type: string; payload: Record<string, unknown> }) =>
        getCommandBus().send(nodeId, command),
    };
    _restoreService = new RestoreService({
      spaces: new SpacesClient(S3_BUCKET),
      nodeConnections: commandAdapter as unknown as NodeConnectionManager, // TODO: WOP-881 will properly type this
      restoreLog: getRestoreLogStore(),
    });
  }
  return _restoreService;
}
