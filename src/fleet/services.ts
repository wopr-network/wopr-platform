import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { AdminAuditLog } from "../admin/audit-log.js";
import { logger } from "../config/logger.js";
import * as dbSchema from "../db/schema/index.js";
import { AdminNotifier } from "./admin-notifier.js";
import { DOClient } from "./do-client.js";
import { HeartbeatWatchdog } from "./heartbeat-watchdog.js";
import { MigrationManager } from "./migration-manager.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
import { NodeProvisioner } from "./node-provisioner.js";
import { RecoveryManager } from "./recovery-manager.js";

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
let _adminNotifier: AdminNotifier | null = null;
let _recoveryManager: RecoveryManager | null = null;
let _heartbeatWatchdog: HeartbeatWatchdog | null = null;
let _migrationManager: MigrationManager | null = null;

export function getDb() {
  if (!_db) {
    _sqlite = new Database(PLATFORM_DB_PATH);
    _sqlite.pragma("journal_mode = WAL");
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

export function getHeartbeatWatchdog() {
  if (!_heartbeatWatchdog) {
    _heartbeatWatchdog = new HeartbeatWatchdog(getDb(), getRecoveryManager(), (nodeId: string, newStatus: string) => {
      logger.info(`Node ${nodeId} status changed to ${newStatus}`);
    });
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
