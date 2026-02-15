import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import { logger } from "../../config/logger.js";
import * as dbSchema from "../../db/schema/index.js";
import { NodeConnectionManager, type NodeRegistration } from "../../fleet/node-connection-manager.js";

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";

/** Lazy-initialized database and node connection manager */
let _db: ReturnType<typeof drizzle<typeof dbSchema>> | null = null;
let _nodeConnections: NodeConnectionManager | null = null;

function getDB() {
  if (!_db) {
    const sqlite = new Database(PLATFORM_DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    _db = drizzle(sqlite, { schema: dbSchema });
  }
  return _db;
}

function getNodeConnections() {
  if (!_nodeConnections) {
    _nodeConnections = new NodeConnectionManager(getDB());
  }
  return _nodeConnections;
}

/**
 * Validate node authentication
 * Returns true if valid, false if invalid credentials, null if NODE_SECRET not configured
 */
function validateNodeAuth(authHeader: string | undefined): boolean | null {
  const nodeSecret = process.env.NODE_SECRET;
  if (!nodeSecret) return null; // Not configured
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === nodeSecret;
}

/**
 * Internal API routes for node agent communication.
 */
export const internalNodeRoutes = new Hono();

/**
 * POST /internal/nodes/register
 * Node registration (called on agent boot)
 */
internalNodeRoutes.post("/register", async (c) => {
  const authHeader = c.req.header("Authorization");
  const authResult = validateNodeAuth(authHeader);

  if (authResult === null) {
    return c.json({ success: false, error: "Node management not configured" }, 503);
  }
  if (authResult === false) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  try {
    const body = (await c.req.json()) as NodeRegistration;

    const nodeConnections = getNodeConnections();
    nodeConnections.registerNode(body);

    logger.info(`Node registered: ${body.node_id}`);

    return c.json({ success: true });
  } catch (err) {
    logger.error("Node registration failed", { err });
    return c.json({ success: false, error: String(err) }, 400);
  }
});

/**
 * WebSocket upgrade handler for node heartbeat + commands.
 * This requires integration with the HTTP server to handle WebSocket upgrades.
 *
 * Example integration in src/index.ts:
 *
 * import { WebSocketServer } from "ws";
 * import { getNodeConnections } from "./api/routes/internal-nodes.js";
 *
 * const wss = new WebSocketServer({ noServer: true });
 *
 * server.on("upgrade", (req, socket, head) => {
 *   const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
 *   const match = pathname.match(/^\/internal\/nodes\/([^\/]+)\/ws$/);
 *
 *   if (match) {
 *     const nodeId = match[1];
 *     const authHeader = req.headers.authorization;
 *     const authResult = validateNodeAuth(authHeader);
 *
 *     if (authResult === null) {
 *       socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
 *       socket.destroy();
 *       return;
 *     }
 *     if (authResult === false) {
 *       socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
 *       socket.destroy();
 *       return;
 *     }
 *
 *     wss.handleUpgrade(req, socket, head, (ws) => {
 *       getNodeConnections().handleWebSocket(nodeId, ws);
 *     });
 *   } else {
 *     socket.destroy();
 *   }
 * });
 */

/**
 * Export helper for WebSocket upgrade handling
 */
export function handleNodeWebSocket(nodeId: string, ws: WebSocket): void {
  const nodeConnections = getNodeConnections();
  nodeConnections.handleWebSocket(nodeId, ws);
}

/**
 * Export helper for node auth validation
 */
export { validateNodeAuth };
