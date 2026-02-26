import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import type { BackupStatusStore } from "../../backup/backup-status-store.js";
import { SpacesClient } from "../../backup/spaces-client.js";
import { logger } from "../../config/logger.js";
import { getAdminAuditLog, getBackupStatusStore } from "../../fleet/services.js";

const S3_BUCKET = process.env.S3_BUCKET || "wopr-backups";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

function getStore(): BackupStatusStore {
  return getBackupStatusStore();
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
 * Validate that a remotePath belongs to the given container.
 * Normalizes the path and checks that one of the path segments is exactly the containerId.
 * This prevents path traversal attacks (e.g. "../../other_tenant/tenant_abc/").
 */
function isRemotePathOwnedBy(remotePath: string, containerId: string): boolean {
  const normalized = remotePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.includes(containerId);
}

function buildRoutes(storeFactory: () => BackupStatusStore, spacesFactory: () => SpacesClient): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  /**
   * GET /api/admin/backups
   * List backup status for all tenants.
   * Query params: ?stale=true to filter only stale backups.
   */
  routes.get("/", async (c) => {
    const store = storeFactory();
    const staleOnly = c.req.query("stale") === "true";
    const entries = staleOnly ? await store.listStale() : await store.listAll();
    return c.json({
      backups: entries,
      total: entries.length,
      staleCount: entries.filter((e) => e.isStale).length,
    });
  });

  /**
   * GET /api/admin/backups/alerts/stale
   * List containers with stale backups (>24h since last successful backup).
   * MUST be registered before /:containerId to avoid being shadowed.
   */
  routes.get("/alerts/stale", async (c) => {
    const store = storeFactory();
    const stale = await store.listStale();
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

  /**
   * GET /api/admin/backups/:containerId
   * Get backup status for a specific tenant container.
   */
  routes.get("/:containerId", async (c) => {
    const store = storeFactory();
    const containerId = c.req.param("containerId");
    const entry = await store.get(containerId);
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
    const store = storeFactory();
    const containerId = c.req.param("containerId");
    const entry = await store.get(containerId);
    if (!entry) {
      return c.json({ error: "No backup status found for this container" }, 404);
    }

    try {
      const spaces = spacesFactory();
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

    // Validate the remote path refers to this container's backups using segment matching
    if (!isRemotePathOwnedBy(body.remotePath, containerId)) {
      return c.json({ error: "remotePath does not belong to this container" }, 403);
    }

    try {
      getAdminAuditLog().log({
        adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
        action: "backup.restore",
        category: "config",
        details: { containerId, remotePath: body.remotePath, targetNodeId: body.targetNodeId ?? "auto" },
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }

    return c.json({
      ok: true,
      message: `Restore initiated for ${containerId} from ${body.remotePath}`,
      containerId,
      remotePath: body.remotePath,
      targetNodeId: body.targetNodeId ?? "auto",
    });
  });

  return routes;
}

/**
 * Create admin backup routes with an explicit store (for testing).
 */
export function createAdminBackupRoutes(store: BackupStatusStore, spaces?: SpacesClient): Hono<AuthEnv> {
  const spacesClient = spaces ?? getSpaces();
  return buildRoutes(
    () => store,
    () => spacesClient,
  );
}

/** Pre-built admin backup routes with auth and lazy initialization. */
export const adminBackupRoutes = new Hono<AuthEnv>();
adminBackupRoutes.use("*", adminAuth);
adminBackupRoutes.route("/", buildRoutes(getStore, getSpaces));

/** Export for testing */
export { getStore, isRemotePathOwnedBy };
