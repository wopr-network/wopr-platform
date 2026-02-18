import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { app } from "./api/app.js";
import { validateNodeAuth } from "./api/routes/internal-nodes.js";
import { config } from "./config/index.js";
import { logger } from "./config/logger.js";
import { ProfileStore } from "./fleet/profile-store.js";
import { getHeartbeatWatchdog, getNodeConnections } from "./fleet/services.js";
import { hydrateProxyRoutes } from "./proxy/singleton.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

const port = config.port;

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

  // Hydrate proxy route table from persisted profiles so tenant subdomains
  // are not lost on server restart.
  await hydrateProxyRoutes(new ProfileStore(DATA_DIR));

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
          getNodeConnections().handleWebSocket(nodeId, ws);
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
