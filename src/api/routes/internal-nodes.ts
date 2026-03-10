import { createHash, randomUUID } from "node:crypto";
import { validateNodeHost } from "@wopr-network/platform-core/security";
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

// BOUNDARY(WOP-805): REST is the correct layer for internal node APIs.
// Node agents authenticate with per-node persistent secrets or registration
// tokens. This is machine-to-machine communication that does not go through
// the dashboard UI.
/**
 * Internal API routes for node agent communication.
 */
export const internalNodeRoutes = new Hono();

/**
 * POST /internal/nodes/register
 * Node registration (called on agent boot).
 *
 * Supports 2 auth paths:
 * 1. Per-node persistent secret (returning self-hosted agent)
 * 2. One-time registration token (new self-hosted node, UUID format)
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

  try {
    validateNodeHost(body.host);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400);
  }

  const registrar = getNodeRegistrar();
  const nodeRepo = getNodeRepo();

  // Map snake_case HTTP body to camelCase domain type
  const registration: NodeRegistration = {
    nodeId: body.node_id,
    host: body.host,
    capacityMb: body.capacity_mb,
    agentVersion: body.agent_version,
  };

  // Path 1: Per-node persistent secret (returning agent)
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
