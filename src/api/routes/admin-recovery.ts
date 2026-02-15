import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import * as dbSchema from "../../db/schema/index.js";
import { AdminNotifier } from "../../fleet/admin-notifier.js";
import { NodeConnectionManager } from "../../fleet/node-connection-manager.js";
import { RecoveryManager } from "../../fleet/recovery-manager.js";

const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || "/data/platform/platform.db";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Lazy-initialized fleet management components */
let _db: ReturnType<typeof drizzle<typeof dbSchema>> | null = null;
let _nodeConnections: NodeConnectionManager | null = null;
let _recoveryManager: RecoveryManager | null = null;

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

function getRecoveryManager() {
  if (!_recoveryManager) {
    const notifier = new AdminNotifier({
      webhookUrl: process.env.ADMIN_WEBHOOK_URL,
    });
    _recoveryManager = new RecoveryManager(getDB(), getNodeConnections(), notifier);
  }
  return _recoveryManager;
}

/**
 * Admin API routes for node recovery history and manual recovery triggers.
 */
export const adminRecoveryRoutes = new Hono<AuthEnv>();

/**
 * GET /api/admin/recovery
 * List recovery events (paginated)
 */
adminRecoveryRoutes.get("/", adminAuth, (c) => {
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
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
 */
export const adminNodeRoutes = new Hono<AuthEnv>();

/**
 * GET /api/admin/nodes
 * List all nodes with status
 */
adminNodeRoutes.get("/", adminAuth, (c) => {
  const nodeConnections = getNodeConnections();
  const nodes = nodeConnections.listNodes();

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
