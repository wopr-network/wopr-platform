import { Hono } from "hono";
import type { WebSocket } from "ws";
import { logger } from "../../config/logger.js";
import type { NodeRegistration } from "../../fleet/node-connection-manager.js";
import { getNodeConnections } from "../../fleet/services.js";

/**
 * Validate node authentication.
 * Returns true if valid, false if invalid credentials, null if NODE_SECRET not configured.
 */
export function validateNodeAuth(authHeader: string | undefined): boolean | null {
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
    return c.json({ success: false, error: "Invalid registration data" }, 400);
  }
});

/**
 * Export helper for WebSocket upgrade handling
 */
export function handleNodeWebSocket(nodeId: string, ws: WebSocket): void {
  const nodeConnections = getNodeConnections();
  nodeConnections.handleWebSocket(nodeId, ws);
}
