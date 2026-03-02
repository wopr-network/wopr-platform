import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import type { NodeRegistration } from "../../fleet/repository-types.js";
import { getNodeRegistrar, getNodeRepo, getRegistrationTokenStore } from "../../fleet/services.js";

const RegisterNodeSchema = z.object({
  node_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9._-]+$/),
  capacity_mb: z.number().int().positive().max(1_048_576),
  agent_version: z.string().min(1).max(32),
});

/**
 * Validate node authentication against static NODE_SECRET.
 * Returns true if valid, false if invalid credentials, null if NODE_SECRET not configured.
 *
 * Kept for backwards compatibility with existing static secret auth and WebSocket upgrade handler.
 */
export function validateNodeAuth(authHeader: string | undefined): boolean | null {
  const nodeSecret = process.env.NODE_SECRET;
  if (!nodeSecret) return null; // Not configured
  if (process.env.DISABLE_STATIC_NODE_SECRET === "true") return false; // Kill-switch active
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(token);
  const b = Buffer.from(nodeSecret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns deprecation warning messages for NODE_SECRET configuration.
 * Called at startup to log warnings. Pure function for testability.
 */
export function getNodeSecretDeprecationWarnings(): string[] {
  const warnings: string[] = [];
  if (!process.env.NODE_SECRET) return warnings;

  warnings.push(
    "[DEPRECATED] NODE_SECRET is set. Static shared-secret node auth is deprecated and will be removed in a future version. " +
      "Migrate to per-node secrets (WOPR_NODE_SECRET) or registration tokens. " +
      "Set DISABLE_STATIC_NODE_SECRET=true to disable the static secret auth path now.",
  );

  if (process.env.DISABLE_STATIC_NODE_SECRET === "true") {
    warnings.push(
      "NODE_SECRET is set but static secret auth is disabled (DISABLE_STATIC_NODE_SECRET=true). " +
        "Only per-node secrets and registration tokens will be accepted.",
    );
  }

  return warnings;
}

// BOUNDARY(WOP-805): REST is the correct layer for internal node APIs.
// Node agents authenticate with static NODE_SECRET or per-node persistent
// secrets — not session cookies. This is machine-to-machine communication
// that does not go through the dashboard UI.
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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid registration data" }, 400);
  }

  const parsed = RegisterNodeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid registration data", details: parsed.error.flatten() }, 400);
  }

  const body = parsed.data;

  const registrar = getNodeRegistrar();
  const nodeRepo = getNodeRepo();

  // Map snake_case HTTP body to camelCase domain type
  const registration: NodeRegistration = {
    nodeId: body.node_id,
    host: body.host,
    capacityMb: body.capacity_mb,
    agentVersion: body.agent_version,
  };

  // Path 1: Static NODE_SECRET (backwards-compatible, can be disabled)
  const staticSecret = process.env.NODE_SECRET;
  const staticDisabled = process.env.DISABLE_STATIC_NODE_SECRET === "true";
  const bearerBuf = Buffer.from(bearer);
  if (staticSecret && !staticDisabled) {
    const secretBuf = Buffer.from(staticSecret);
    if (bearerBuf.length === secretBuf.length && timingSafeEqual(bearerBuf, secretBuf)) {
      // Verify per-node secret if the node has one stored
      const nodeSecretHeader = c.req.header("X-Node-Secret");
      const verified = await nodeRepo.verifyNodeSecret(registration.nodeId, nodeSecretHeader ?? "");

      if (verified === false) {
        // Node exists and has a secret, but the provided one doesn't match
        logger.warn(`Node ${registration.nodeId} rejected: invalid per-node secret`);
        return c.json({ success: false, error: "Invalid per-node node secret" }, 401);
      }

      if (verified === null) {
        // Legacy node with no stored secret, or node not found — allow through
        if (nodeSecretHeader) {
          logger.warn(`Node ${registration.nodeId} registered with unverifiable per-node secret (legacy node)`);
        }
      }

      await registrar.register(registration);
      logger.info(`Node registered via static secret: ${registration.nodeId}`);
      return c.json({ success: true });
    }
  }

  // Path 2: Per-node persistent secret (returning agent)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(bearer)) {
    // Might be a per-node secret (wopr_node_ prefix or similar non-UUID format)
    const existingNode = await nodeRepo.getBySecret(bearer);
    if (existingNode) {
      await registrar.register({ ...registration, nodeId: existingNode.id });
      logger.info(`Node re-registered via per-node secret: ${existingNode.id}`);
      return c.json({ success: true });
    }
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Path 3: One-time registration token (UUID format = registration token)
  const tokenStore = getRegistrationTokenStore();
  const nodeId = `self-${randomUUID().slice(0, 8)}`;
  const consumed = await tokenStore.consume(bearer, nodeId);

  if (!consumed) {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }

  // Generate persistent per-node secret
  const nodeSecret = `wopr_node_${randomUUID().replace(/-/g, "")}`;
  const hashedSecret = createHash("sha256").update(nodeSecret).digest("hex");

  // Register self-hosted node via registrar
  await registrar.registerSelfHosted({
    ...registration,
    nodeId,
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
