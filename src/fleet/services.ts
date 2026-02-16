import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import * as dbSchema from "../db/schema/index.js";
import { DrizzleBotInstanceRepository } from "../infrastructure/persistence/drizzle-bot-instance-repository.js";
import { DrizzleNodeRepository } from "../infrastructure/persistence/drizzle-node-repository.js";
import { DrizzleRecoveryRepository } from "../infrastructure/persistence/drizzle-recovery-repository.js";
import { AdminNotifier } from "./admin-notifier.js";
import { HeartbeatWatchdog } from "./heartbeat-watchdog.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
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
let _nodeRepository: DrizzleNodeRepository | null = null;
let _botInstanceRepository: DrizzleBotInstanceRepository | null = null;
let _recoveryRepository: DrizzleRecoveryRepository | null = null;
let _nodeConnections: NodeConnectionManager | null = null;
let _adminNotifier: AdminNotifier | null = null;
let _recoveryManager: RecoveryManager | null = null;
let _heartbeatWatchdog: HeartbeatWatchdog | null = null;

export function getDb() {
  if (!_db) {
    _sqlite = new Database(PLATFORM_DB_PATH);
    _sqlite.pragma("journal_mode = WAL");
    _db = drizzle(_sqlite, { schema: dbSchema });
  }
  return _db;
}

export function getNodeRepository() {
  if (!_nodeRepository) {
    _nodeRepository = new DrizzleNodeRepository(getDb());
  }
  return _nodeRepository;
}

export function getBotInstanceRepository() {
  if (!_botInstanceRepository) {
    _botInstanceRepository = new DrizzleBotInstanceRepository(getDb());
  }
  return _botInstanceRepository;
}

export function getRecoveryRepository() {
  if (!_recoveryRepository) {
    _recoveryRepository = new DrizzleRecoveryRepository(getDb());
  }
  return _recoveryRepository;
}

export function getNodeConnections() {
  if (!_nodeConnections) {
    _nodeConnections = new NodeConnectionManager(getNodeRepository(), getBotInstanceRepository());
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
    _recoveryManager = new RecoveryManager(getDb(), getNodeConnections(), getAdminNotifier(), getRecoveryRepository());
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
