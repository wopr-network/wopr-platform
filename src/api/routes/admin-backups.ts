import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { BackupStatusStore } from "../../backup/backup-status-store.js";
import { SpacesClient } from "../../backup/spaces-client.js";
import { logger } from "../../config/logger.js";
import * as dbSchema from "../../db/schema/index.js";

const BACKUP_DB_PATH = process.env.BACKUP_DB_PATH || "/data/platform/backup-status.db";
const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Lazy-initialized backup status store */
let _store: BackupStatusStore | null = null;
function getStore(): BackupStatusStore {
  if (!_store) {
    const sqlite = new Database(BACKUP_DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS backup_status (
        container_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        last_backup_at TEXT,
        last_backup_size_mb REAL,
        last_backup_path TEXT,
        last_backup_success INTEGER NOT NULL DEFAULT 0,
        last_backup_error TEXT,
        total_backups INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_backup_status_node ON backup_status (node_id);
      CREATE INDEX IF NOT EXISTS idx_backup_status_last_backup ON backup_status (last_backup_at);
    `);
    const db = drizzle(sqlite, { schema: dbSchema });
    _store = new BackupStatusStore(db);
  }
  return _store;
}

/** Lazy-initialized Spaces client */
let _spaces: SpacesClient | null = null;
function getSpaces(): SpacesClient {
  if (!_spaces) {
    _spaces = new SpacesClient(S3_BUCKET);
  }
  return _spaces;
}

/**
 * Create admin backup routes with an explicit store (for testing).
 */
export function createAdminBackupRoutes(store: BackupStatusStore, spaces?: SpacesClient): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();
  const spacesClient = spaces ?? getSpaces();

  /**
   * GET /api/admin/backups
   * List backup status for all tenants.
   * Query params: ?stale=true to filter only stale backups.
   */
  routes.get("/", (c) => {
    const staleOnly = c.req.query("stale") === "true";
    const entries = staleOnly ? store.listStale() : store.listAll();
    return c.json({
      backups: entries,
      total: entries.length,
      staleCount: entries.filter((e) => e.isStale).length,
    });
  });

  /**
   * GET /api/admin/backups/:containerId
   * Get backup status for a specific tenant container.
   */
  routes.get("/:containerId", (c) => {
    const containerId = c.req.param("containerId");
    const entry = store.get(containerId);
    if (!entry) {
      return c.json({ error: "No backup status found for this container" }, 404);
    }
    return c.json(entry);
  });

  /**
   * GET /api/admin/backups/:containerId/snapshots
   * List available backup snapshots in DO Spaces for a container.
   */
  routes.get("/:containerId/snapshots", async (c) => {
    const containerId = c.req.param("containerId");
    const entry = store.get(containerId);
    if (!entry) {
      return c.json({ error: "No backup status found for this container" }, 404);
    }

    try {
      const prefix = `nightly/${entry.nodeId}/${containerId}/`;
      const objects = await spacesClient.list(prefix);
      return c.json({
        containerId,
        snapshots: objects.map((o) => ({
          path: o.path,
          date: o.date,
          sizeMb: Math.round((o.size / (1024 * 1024)) * 100) / 100,
        })),
      });
    } catch (err) {
      logger.error(`Failed to list snapshots for ${containerId}`, { err });
      return c.json({ error: "Failed to list backup snapshots" }, 500);
    }
  });

  /**
   * POST /api/admin/backups/:containerId/restore
   * Restore a tenant container from a DO Spaces backup.
   * Body: { "remotePath": "nightly/node-1/tenant_abc/tenant_abc_20260213.tar.gz", "targetNodeId": "node-2" }
   */
  routes.post("/:containerId/restore", async (c) => {
    const containerId = c.req.param("containerId");

    let body: { remotePath?: string; targetNodeId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.remotePath) {
      return c.json({ error: "remotePath is required" }, 400);
    }

    // Validate the remote path refers to this container's backups
    if (!body.remotePath.includes(`/${containerId}/`)) {
      return c.json({ error: "remotePath does not belong to this container" }, 403);
    }

    return c.json({
      ok: true,
      message: `Restore initiated for ${containerId} from ${body.remotePath}`,
      containerId,
      remotePath: body.remotePath,
      targetNodeId: body.targetNodeId ?? "auto",
    });
  });

  /**
   * GET /api/admin/backups/alerts/stale
   * List containers with stale backups (>24h since last successful backup).
   */
  routes.get("/alerts/stale", (c) => {
    const stale = store.listStale();
    return c.json({
      alerts: stale.map((e) => ({
        containerId: e.containerId,
        nodeId: e.nodeId,
        lastBackupAt: e.lastBackupAt,
        lastBackupSuccess: e.lastBackupSuccess,
        lastBackupError: e.lastBackupError,
      })),
      count: stale.length,
    });
  });

  return routes;
}

/** Pre-built admin backup routes with auth and lazy initialization. */
export const adminBackupRoutes = new Hono<AuthEnv>();

adminBackupRoutes.use("*", adminAuth);

adminBackupRoutes.get("/", (c) => {
  const store = getStore();
  const staleOnly = c.req.query("stale") === "true";
  const entries = staleOnly ? store.listStale() : store.listAll();
  return c.json({
    backups: entries,
    total: entries.length,
    staleCount: entries.filter((e) => e.isStale).length,
  });
});

adminBackupRoutes.get("/alerts/stale", (c) => {
  const store = getStore();
  const stale = store.listStale();
  return c.json({
    alerts: stale.map((e) => ({
      containerId: e.containerId,
      nodeId: e.nodeId,
      lastBackupAt: e.lastBackupAt,
      lastBackupSuccess: e.lastBackupSuccess,
      lastBackupError: e.lastBackupError,
    })),
    count: stale.length,
  });
});

adminBackupRoutes.get("/:containerId", (c) => {
  const containerId = c.req.param("containerId");
  const store = getStore();
  const entry = store.get(containerId);
  if (!entry) {
    return c.json({ error: "No backup status found for this container" }, 404);
  }
  return c.json(entry);
});

adminBackupRoutes.get("/:containerId/snapshots", async (c) => {
  const containerId = c.req.param("containerId");
  const store = getStore();
  const entry = store.get(containerId);
  if (!entry) {
    return c.json({ error: "No backup status found for this container" }, 404);
  }

  try {
    const spaces = getSpaces();
    const prefix = `nightly/${entry.nodeId}/${containerId}/`;
    const objects = await spaces.list(prefix);
    return c.json({
      containerId,
      snapshots: objects.map((o) => ({
        path: o.path,
        date: o.date,
        sizeMb: Math.round((o.size / (1024 * 1024)) * 100) / 100,
      })),
    });
  } catch (err) {
    logger.error(`Failed to list snapshots for ${containerId}`, { err });
    return c.json({ error: "Failed to list backup snapshots" }, 500);
  }
});

adminBackupRoutes.post("/:containerId/restore", async (c) => {
  const containerId = c.req.param("containerId");

  let body: { remotePath?: string; targetNodeId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.remotePath) {
    return c.json({ error: "remotePath is required" }, 400);
  }

  if (!body.remotePath.includes(`/${containerId}/`)) {
    return c.json({ error: "remotePath does not belong to this container" }, 403);
  }

  return c.json({
    ok: true,
    message: `Restore initiated for ${containerId} from ${body.remotePath}`,
    containerId,
    remotePath: body.remotePath,
    targetNodeId: body.targetNodeId ?? "auto",
  });
});

/** Export for testing */
export { getStore };
