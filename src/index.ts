import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { WebSocketServer } from "ws";
import { app } from "./api/app.js";
import { handleNodeWebSocket, validateNodeAuth } from "./api/routes/internal-nodes.js";
import { config } from "./config/index.js";
import { logger } from "./config/logger.js";
import * as dbSchema from "./db/schema/index.js";
import { AdminNotifier } from "./fleet/admin-notifier.js";
import { HeartbeatWatchdog } from "./fleet/heartbeat-watchdog.js";
import { NodeConnectionManager } from "./fleet/node-connection-manager.js";
import { RecoveryManager } from "./fleet/recovery-manager.js";

const port = config.port;

// Lazy database initialization to avoid issues when module is imported in tests
const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";
let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _nodeConnections: NodeConnectionManager | null = null;
let _adminNotifier: AdminNotifier | null = null;
let _recoveryManager: RecoveryManager | null = null;
let _heartbeatWatchdog: HeartbeatWatchdog | null = null;

function getDb() {
  if (!_db) {
    _sqlite = new Database(PLATFORM_DB_PATH);
    _sqlite.pragma("journal_mode = WAL");
    _db = drizzle(_sqlite, { schema: dbSchema });
  }
  return _db;
}

function getNodeConnections() {
  if (!_nodeConnections) {
    _nodeConnections = new NodeConnectionManager(getDb());
  }
  return _nodeConnections;
}

function getAdminNotifier() {
  if (!_adminNotifier) {
    _adminNotifier = new AdminNotifier();
  }
  return _adminNotifier;
}

function getRecoveryManager() {
  if (!_recoveryManager) {
    _recoveryManager = new RecoveryManager(getDb(), getNodeConnections(), getAdminNotifier());
  }
  return _recoveryManager;
}

function getHeartbeatWatchdog() {
  if (!_heartbeatWatchdog) {
    _heartbeatWatchdog = new HeartbeatWatchdog(getDb(), getRecoveryManager(), (nodeId: string, newStatus: string) => {
      logger.info(`Node ${nodeId} status changed to ${newStatus}`);
    });
  }
  return _heartbeatWatchdog;
}

// Global process-level error handlers to prevent crashes from unhandled errors.
// These handlers ensure the process logs critical errors and handles them gracefully.

// Handle unhandled promise rejections (async errors that weren't caught)
export const unhandledRejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise),
  });
  // Don't exit — log and continue serving other tenants
};

// Handle uncaught exceptions (synchronous errors that weren't caught)
export const uncaughtExceptionHandler = (err: Error, origin: string) => {
  logger.error("Uncaught exception", {
    error: err.message,
    stack: err.stack,
    origin,
  });
  // Uncaught exceptions leave the process in an undefined state.
  // Exit immediately after logging (Winston Console transport is synchronous).
  process.exit(1);
};

process.on("unhandledRejection", unhandledRejectionHandler);
process.on("uncaughtException", uncaughtExceptionHandler);

// Only start the server if not imported by tests
if (process.env.NODE_ENV !== "test") {
  logger.info(`wopr-platform starting on port ${port}`);

  // Start heartbeat watchdog
  getHeartbeatWatchdog().start();

  const server = serve({ fetch: app.fetch, port }, () => {
    logger.info(`wopr-platform listening on http://0.0.0.0:${port}`);
  });

  // Set up WebSocket server for node agent connections
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const pathname = url.pathname;
      const match = pathname.match(/^\/internal\/nodes\/([^/]+)\/ws$/);

      if (match) {
        const nodeId = match[1];
        const authHeader = req.headers.authorization;

        const authResult = validateNodeAuth(authHeader);
        if (authResult === null) {
          // NODE_SECRET not configured — node management disabled
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }
        if (!authResult) {
          // Invalid secret
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          handleNodeWebSocket(nodeId, ws);
        });
      } else {
        socket.destroy();
      }
    } catch (err) {
      logger.error("WebSocket upgrade error", { err });
      socket.destroy();
    }
  });
}
