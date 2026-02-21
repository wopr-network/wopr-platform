import Database from "better-sqlite3";
import { AdminAuditLog } from "../admin/audit-log.js";
import { RestoreLogStore } from "../backup/restore-log-store.js";
import { RestoreService } from "../backup/restore-service.js";
import { SpacesClient } from "../backup/spaces-client.js";
import { logger } from "../config/logger.js";
import { applyPlatformPragmas, createDb, type DrizzleDb } from "../db/index.js";
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

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";

/**
 * Shared lazy-initialized fleet management singletons.
 * All files that need DB/repositories/orchestrators import from here
 * to ensure a single set of instances across the application.
 *
 * Nothing runs at import time — all initialization is deferred to first call.
 */

let _sqlite: Database.Database | null = null;
let _db: DrizzleDb | null = null;
let _registrationTokenStore: RegistrationTokenStore | null = null;
let _adminNotifier: AdminNotifier | null = null;

// Repositories
let _nodeRepo: INodeRepository | null = null;
let _botInstanceRepo: IBotInstanceRepository | null = null;
let _botProfileRepo: IBotProfileRepository | null = null;
let _recoveryRepo: IRecoveryRepository | null = null;

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
