import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { getNodeConnections, getRecoveryManager } from "../../fleet/services.js";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/**
 * Admin API routes for node recovery history and manual recovery triggers.
 */
export const adminRecoveryRoutes = new Hono<AuthEnv>();

/**
 * GET /api/admin/recovery
 * List recovery events (paginated)
 */
adminRecoveryRoutes.get("/", adminAuth, async (c) => {
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 500);
  const recoveryManager = getRecoveryManager();

  const events = await recoveryManager.listEvents(limit);

  return c.json({
    success: true,
    events,
    count: events.length,
  });
});

/**
 * GET /api/admin/recovery/:eventId
 * Get recovery event details with items
 */
adminRecoveryRoutes.get("/:eventId", adminAuth, async (c) => {
  const eventId = c.req.param("eventId");
  const recoveryManager = getRecoveryManager();

  const { event, items } = await recoveryManager.getEventDetails(eventId);

  if (!event) {
    return c.json(
      {
        success: false,
        error: "Recovery event not found",
      },
      404,
    );
  }

  return c.json({
    success: true,
    event,
    items,
  });
});

/**
 * POST /api/admin/recovery/:eventId/retry
 * Retry waiting tenants for a recovery event
 */
adminRecoveryRoutes.post("/:eventId/retry", adminAuth, async (c) => {
  const eventId = c.req.param("eventId");
  const recoveryManager = getRecoveryManager();

  try {
    const report = await recoveryManager.retryWaiting(eventId);

    return c.json({
      success: true,
      report,
    });
  } catch (err) {
    logger.error("Failed to retry waiting tenants", { eventId, err });
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * Admin API routes for node management.
 */
export const adminNodeRoutes = new Hono<AuthEnv>();

/**
 * GET /api/admin/nodes
 * List all nodes with status
 */
adminNodeRoutes.get("/", adminAuth, async (c) => {
  const nodeConnections = getNodeConnections();
  const nodes = await nodeConnections.listNodes();

  return c.json({
    success: true,
    nodes,
    count: nodes.length,
  });
});

/**
 * POST /api/admin/nodes/:nodeId/recover
 * Manually trigger recovery for a specific node
 */
adminNodeRoutes.post("/:nodeId/recover", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");
  const recoveryManager = getRecoveryManager();

  try {
    const report = await recoveryManager.triggerRecovery(nodeId, "manual");

    return c.json({
      success: true,
      report,
    });
  } catch (err) {
    logger.error("Manual recovery failed", { nodeId, err });
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * GET /api/admin/nodes/:nodeId/tenants
 * Get tenants assigned to a specific node
 */
adminNodeRoutes.get("/:nodeId/tenants", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");
  const nodeConnections = getNodeConnections();

  const tenants = await nodeConnections.getNodeTenants(nodeId);

  return c.json({
    success: true,
    tenants,
    count: tenants.length,
  });
});
