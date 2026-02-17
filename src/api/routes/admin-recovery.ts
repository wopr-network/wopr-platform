import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { botInstances, nodes as nodesSchema } from "../../db/schema/index.js";
import { checkCapacityAlerts } from "../../fleet/capacity-alerts.js";
import {
  getAdminAuditLog,
  getDb,
  getMigrationManager,
  getNodeConnections,
  getNodeProvisioner,
  getRecoveryManager,
} from "../../fleet/services.js";

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
adminRecoveryRoutes.get("/", adminAuth, (c) => {
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 500);
  const recoveryManager = getRecoveryManager();

  const events = recoveryManager.listEvents(limit);

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
adminRecoveryRoutes.get("/:eventId", adminAuth, (c) => {
  const eventId = c.req.param("eventId");
  const recoveryManager = getRecoveryManager();

  const { event, items } = recoveryManager.getEventDetails(eventId);

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
 *
 * IMPORTANT: Static routes (/regions, /sizes, /migrate) are registered BEFORE
 * parameterized routes (/:nodeId) so Hono does not match "regions" as a nodeId.
 */
export const adminNodeRoutes = new Hono<AuthEnv>();

/**
 * GET /api/admin/nodes
 * List all nodes with status and capacity alerts
 */
adminNodeRoutes.get("/", adminAuth, (c) => {
  const nodeConnections = getNodeConnections();
  const nodes = nodeConnections.listNodes();
  const alerts = checkCapacityAlerts(nodes);

  return c.json({
    success: true,
    nodes,
    count: nodes.length,
    alerts,
  });
});

/**
 * POST /api/admin/nodes
 * Provision a new node via DigitalOcean API
 */
adminNodeRoutes.post("/", adminAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = z
      .object({
        region: z.string().min(1).max(20).optional(),
        size: z.string().min(1).max(50).optional(),
        name: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
          .optional(),
      })
      .parse(body);

    const provisioner = getNodeProvisioner();
    const result = await provisioner.provision(parsed);

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "node.provision",
      category: "config",
      details: {
        nodeId: result.nodeId,
        dropletId: result.dropletId,
        region: result.region,
        size: result.size,
        monthlyCostCents: result.monthlyCostCents,
      },
    });

    return c.json({ success: true, node: result }, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("DO_API_TOKEN")) {
      return c.json(
        {
          success: false,
          error: "Node provisioning not configured. Set DO_API_TOKEN environment variable.",
        },
        503,
      );
    }
    logger.error("Node provisioning failed", { err });
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
 * POST /api/admin/nodes/migrate
 * Migrate a specific tenant from one node to another
 * MUST be before /:nodeId to avoid route collision
 */
adminNodeRoutes.post("/migrate", adminAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = z
      .object({
        botId: z.string().min(1),
        targetNodeId: z.string().min(1),
      })
      .parse(body);

    const db = getDb();
    const bot = db.select().from(botInstances).where(eq(botInstances.id, parsed.botId)).get();
    if (!bot) {
      return c.json({ success: false, error: "Bot not found" }, 404);
    }
    if (!bot.nodeId) {
      return c.json({ success: false, error: "Bot has no node assignment" }, 400);
    }

    if (bot.nodeId === parsed.targetNodeId) {
      return c.json({ success: false, error: "Source and target nodes are the same" }, 400);
    }

    const migrationManager = getMigrationManager();
    const result = await migrationManager.migrateTenant(parsed.botId, parsed.targetNodeId);

    if (!result.success) {
      return c.json({ success: false, error: result.error }, 500);
    }

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "node.migrate",
      category: "config",
      details: {
        botId: parsed.botId,
        tenantId: bot.tenantId,
        sourceNode: result.sourceNodeId,
        targetNode: result.targetNodeId,
        downtimeMs: result.downtimeMs,
      },
    });

    return c.json({
      success: true,
      migration: {
        botId: parsed.botId,
        from: result.sourceNodeId,
        to: result.targetNodeId,
        downtimeMs: result.downtimeMs,
      },
    });
  } catch (err) {
    logger.error("Manual migration failed", { err });
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
 * GET /api/admin/nodes/regions
 * List available DO regions
 * MUST be before /:nodeId to avoid route collision
 */
adminNodeRoutes.get("/regions", adminAuth, async (c) => {
  try {
    const provisioner = getNodeProvisioner();
    const regions = await provisioner.listRegions();
    return c.json({ success: true, regions });
  } catch (err) {
    if (err instanceof Error && err.message.includes("DO_API_TOKEN")) {
      return c.json(
        {
          success: false,
          error: "Node provisioning not configured. Set DO_API_TOKEN environment variable.",
        },
        503,
      );
    }
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
 * GET /api/admin/nodes/sizes
 * List available DO droplet sizes
 * MUST be before /:nodeId to avoid route collision
 */
adminNodeRoutes.get("/sizes", adminAuth, async (c) => {
  try {
    const provisioner = getNodeProvisioner();
    const sizes = await provisioner.listSizes();
    return c.json({ success: true, sizes });
  } catch (err) {
    if (err instanceof Error && err.message.includes("DO_API_TOKEN")) {
      return c.json(
        {
          success: false,
          error: "Node provisioning not configured. Set DO_API_TOKEN environment variable.",
        },
        503,
      );
    }
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
 * GET /api/admin/nodes/:nodeId
 * Get node detail including tenant list and provisioning info
 */
adminNodeRoutes.get("/:nodeId", adminAuth, (c) => {
  const nodeId = c.req.param("nodeId");
  const nodeConnections = getNodeConnections();

  const node = nodeConnections.getNode(nodeId);
  if (!node) {
    return c.json({ success: false, error: "Node not found" }, 404);
  }

  const tenants = nodeConnections.getNodeTenants(nodeId);

  return c.json({
    success: true,
    node,
    tenants,
    tenantCount: tenants.length,
  });
});

/**
 * DELETE /api/admin/nodes/:nodeId
 * Destroy a node (must be drained/empty first)
 */
adminNodeRoutes.delete("/:nodeId", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");

  try {
    const provisioner = getNodeProvisioner();
    await provisioner.destroy(nodeId);

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "node.destroy",
      category: "config",
      details: { nodeId },
    });

    return c.json({ success: true });
  } catch (err) {
    logger.error("Node destruction failed", { nodeId, err });
    const status = err instanceof Error && err.message.includes("must be drained") ? 409 : 500;
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      status,
    );
  }
});

/**
 * GET /api/admin/nodes/:nodeId/tenants
 * Get tenants assigned to a specific node
 */
adminNodeRoutes.get("/:nodeId/tenants", adminAuth, (c) => {
  const nodeId = c.req.param("nodeId");
  const nodeConnections = getNodeConnections();

  const tenants = nodeConnections.getNodeTenants(nodeId);

  return c.json({
    success: true,
    tenants,
    count: tenants.length,
  });
});

/**
 * GET /api/admin/nodes/:nodeId/stats
 * Get live capacity stats for a node via node agent command
 */
adminNodeRoutes.get("/:nodeId/stats", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");

  try {
    const nodeConnections = getNodeConnections();
    const result = await nodeConnections.sendCommand(nodeId, { type: "stats.get", payload: {} }, 15_000);

    return c.json({ success: true, stats: result.data });
  } catch (err) {
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
 * POST /api/admin/nodes/:nodeId/drain
 * Drain all tenants from a node (for decommissioning or maintenance).
 */
adminNodeRoutes.post("/:nodeId/drain", adminAuth, async (c) => {
  const nodeId = c.req.param("nodeId");

  try {
    const migrationManager = getMigrationManager();
    const result = await migrationManager.drainNode(nodeId);

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "node.drain.start",
      category: "config",
      details: { nodeId, migrated: result.migrated.length, failed: result.failed.length },
    });

    return c.json({
      success: result.failed.length === 0,
      result,
    });
  } catch (err) {
    logger.error("Drain failed", { nodeId, err });
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * POST /api/admin/nodes/:nodeId/cancel-drain
 * Cancel an in-progress drain (marks node back to active)
 */
adminNodeRoutes.post("/:nodeId/cancel-drain", adminAuth, (c) => {
  const nodeId = c.req.param("nodeId");

  try {
    // Mark node back to active status and clear drain tracking
    const db = getDb();
    db.update(nodesSchema)
      .set({
        status: "active",
        drainStatus: null,
        drainMigrated: null,
        drainTotal: null,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(nodesSchema.id, nodeId))
      .run();

    getAdminAuditLog().log({
      adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
      action: "node.drain.cancel",
      category: "config",
      details: { nodeId },
    });

    return c.json({ success: true, message: `Drain cancelled for node ${nodeId}` });
  } catch (err) {
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
