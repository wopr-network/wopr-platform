import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import { logger } from "../../config/logger.js";
import type { NodeRegistration } from "../../fleet/node-connection-manager.js";
import { getNodeConnections, getRegistrationTokenStore } from "../../fleet/services.js";

/**
 * Validate node authentication against static NODE_SECRET.
 * Returns true if valid, false if invalid credentials, null if NODE_SECRET not configured.
 *
 * Kept for backwards compatibility with existing static secret auth and WebSocket upgrade handler.
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
 * Node registration (called on agent boot).
 *
 * Supports 3 auth paths:
 * 1. Static NODE_SECRET (backwards-compatible)
 * 2. Per-node persistent secret (returning self-hosted agent)
 * 3. One-time registration token (new self-hosted node, UUID format)
 */
internalNodeRoutes.post("/register", async (c) => {
  const authHeader = c.req.header("Authorization");
  const bearer = authHeader?.replace(/^Bearer\s+/i, "");

  if (!bearer) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  let body: NodeRegistration;
  try {
    body = (await c.req.json()) as NodeRegistration;
  } catch {
    return c.json({ success: false, error: "Invalid registration data" }, 400);
  }

  const nodeConnections = getNodeConnections();

  // Path 1: Static NODE_SECRET (backwards-compatible)
  const staticSecret = process.env.NODE_SECRET;
  if (staticSecret && bearer === staticSecret) {
    nodeConnections.registerNode(body);
    logger.info(`Node registered via static secret: ${body.node_id}`);
    return c.json({ success: true });
  }

  // Path 2: Per-node persistent secret (returning agent)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(bearer)) {
    // Might be a per-node secret (wopr_node_ prefix or similar non-UUID format)
    const existingNode = nodeConnections.getNodeBySecret(bearer);
    if (existingNode) {
      nodeConnections.registerNode({ ...body, node_id: existingNode.id });
      logger.info(`Node re-registered via per-node secret: ${existingNode.id}`);
      return c.json({ success: true });
    }
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Path 3: One-time registration token (UUID format = registration token)
  const tokenStore = getRegistrationTokenStore();
  const nodeId = `self-${randomUUID().slice(0, 8)}`;
  const consumed = tokenStore.consume(bearer, nodeId);

  if (!consumed) {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }

  // Generate persistent per-node secret
  const nodeSecret = `wopr_node_${randomUUID().replace(/-/g, "")}`;
  const hashedSecret = createHash("sha256").update(nodeSecret).digest("hex");

  // Register node with owner info
  nodeConnections.registerSelfHostedNode({
    ...body,
    node_id: nodeId,
    ownerUserId: consumed.userId,
    label: consumed.label,
    nodeSecretHash: hashedSecret,
  });

  logger.info(`Self-hosted node registered: ${nodeId} for user ${consumed.userId}`);

  return c.json({
    success: true,
    node_id: nodeId,
    node_secret: nodeSecret, // Agent saves this — only returned once
  });
});

/**
 * Export helper for WebSocket upgrade handling
 */
export function handleNodeWebSocket(nodeId: string, ws: WebSocket): void {
  const nodeConnections = getNodeConnections();
  nodeConnections.handleWebSocket(nodeId, ws);
}
