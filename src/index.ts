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

// Initialize database and fleet services
const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";
const sqlite = new Database(PLATFORM_DB_PATH);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite, { schema: dbSchema });

// Initialize fleet recovery system
const nodeConnections = new NodeConnectionManager(db);
const adminNotifier = new AdminNotifier();
const recoveryManager = new RecoveryManager(db, nodeConnections, adminNotifier);

// Initialize heartbeat watchdog
const heartbeatWatchdog = new HeartbeatWatchdog(db, recoveryManager, (nodeId: string, newStatus: string) => {
  logger.info(`Node ${nodeId} status changed to ${newStatus}`);
});

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

logger.info(`wopr-platform starting on port ${port}`);

// Start heartbeat watchdog
heartbeatWatchdog.start();

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

      if (!validateNodeAuth(authHeader)) {
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
