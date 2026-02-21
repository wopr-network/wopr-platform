import Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { AdminAuditLog } from "../admin/audit-log.js";
import { RestoreLogStore } from "../backup/restore-log-store.js";
import { RestoreService } from "../backup/restore-service.js";
import { SpacesClient } from "../backup/spaces-client.js";
import { logger } from "../config/logger.js";
import { applyPlatformPragmas } from "../db/pragmas.js";
import * as dbSchema from "../db/schema/index.js";
import { nodes } from "../db/schema/index.js";
import { AdminNotifier } from "./admin-notifier.js";
import { DOClient } from "./do-client.js";
import { HeartbeatWatchdog } from "./heartbeat-watchdog.js";
import { MigrationManager } from "./migration-manager.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
import { NodeProvisioner } from "./node-provisioner.js";
import { RecoveryManager } from "./recovery-manager.js";
import { RegistrationTokenStore } from "./registration-token-store.js";
// TODO: WOP-864 — replace inline shim with: import { DrizzleNodeRepository } from "./node-repository.js";
import type { INodeRepository, Node, NodeStatus } from "./repository-types.js";

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";

/**
 * Shared lazy-initialized fleet management singletons.
 * All files that need DB/NodeConnectionManager/RecoveryManager import from here
 * to ensure a single set of instances across the application.
 *
 * Nothing runs at import time — all initialization is deferred to first call.
 */

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle<typeof dbSchema>> | null = null;
let _nodeConnections: NodeConnectionManager | null = null;
let _registrationTokenStore: RegistrationTokenStore | null = null;
let _adminNotifier: AdminNotifier | null = null;
let _recoveryManager: RecoveryManager | null = null;
// TODO: WOP-864 — replace _nodeRepository type with DrizzleNodeRepository
let _nodeRepository: INodeRepository | null = null;
let _heartbeatWatchdog: HeartbeatWatchdog | null = null;
let _migrationManager: MigrationManager | null = null;

export function getDb() {
  if (!_db) {
    _sqlite = new Database(PLATFORM_DB_PATH);
    applyPlatformPragmas(_sqlite);
    _db = drizzle(_sqlite, { schema: dbSchema });
  }
  return _db;
}

export function getNodeConnections() {
  if (!_nodeConnections) {
    _nodeConnections = new NodeConnectionManager(getDb());
  }
  return _nodeConnections;
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

export function getRecoveryManager() {
  if (!_recoveryManager) {
    _recoveryManager = new RecoveryManager(getDb(), getNodeConnections(), getAdminNotifier());
  }
  return _recoveryManager;
}

// TODO: WOP-864 — replace this inline shim with: new DrizzleNodeRepository(getDb())
export function getNodeRepository(): INodeRepository {
  if (!_nodeRepository) {
    const db = getDb();
    _nodeRepository = {
      list(statuses?: NodeStatus[]): Node[] {
        if (statuses && statuses.length > 0) {
          return db.select().from(nodes).where(inArray(nodes.status, statuses)).all() as Node[];
        }
        return db.select().from(nodes).all() as Node[];
      },
      transition(id: string, to: NodeStatus, _reason: string, _triggeredBy: string): Node {
        const now = Math.floor(Date.now() / 1000);
        db.update(nodes).set({ status: to, updatedAt: now }).where(eq(nodes.id, id)).run();
        return db.select().from(nodes).where(eq(nodes.id, id)).get() as Node;
      },
    };
  }
  return _nodeRepository;
}

export function getHeartbeatWatchdog() {
  if (!_heartbeatWatchdog) {
    _heartbeatWatchdog = new HeartbeatWatchdog(
      getNodeRepository(),
      getRecoveryManager(),
      (nodeId: string, newStatus: string) => {
        logger.info(`Node ${nodeId} status changed to ${newStatus}`);
      },
    );
  }
  return _heartbeatWatchdog;
}

export function getMigrationManager() {
  if (!_migrationManager) {
    _migrationManager = new MigrationManager(getDb(), getNodeConnections(), getAdminNotifier());
  }
  return _migrationManager;
}

let _doClient: DOClient | null = null;
let _nodeProvisioner: NodeProvisioner | null = null;
let _adminAuditLog: AdminAuditLog | null = null;
let _restoreLogStore: RestoreLogStore | null = null;
let _restoreService: RestoreService | null = null;

const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

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
      nodeConnections: getNodeConnections(),
      restoreLog: getRestoreLogStore(),
    });
  }
  return _restoreService;
}
