import { Hono } from "hono";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { enforceRetention } from "../../backup/retention.js";
import { type SnapshotManager, SnapshotNotFoundError } from "../../backup/snapshot-manager.js";
import { createSnapshotSchema, tierSchema } from "../../backup/types.js";
import { logger } from "../../config/logger.js";
import { getSnapshotManager } from "../../fleet/services.js";

const WOPR_HOME_BASE = process.env.WOPR_HOME_BASE || "/data/instances";
const FLEET_DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const tokenMetadataMap = buildTokenMetadataMap();

/** Validates that an instance/snapshot ID contains only safe characters (no path traversal). */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function getManager(): SnapshotManager {
  return getSnapshotManager();
}

export const snapshotRoutes = new Hono<{ Bindings: Record<string, never> }>();

if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured -- snapshot routes will reject all requests");
}
// Listing snapshots = read; creating/restoring/deleting = write (enforced per-route)
snapshotRoutes.use("/*", scopedBearerAuthWithTenant(tokenMetadataMap, "read"));

/**
 * POST /api/instances/:id/snapshots -- Create a snapshot
 *
 * Auth: Tenant-scoped bearer token. Validates that the token's tenant owns the instance.
 */
const writeAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "write");

/** Helper to get instance tenantId from bot profile */
async function getInstanceTenantId(instanceId: string): Promise<string | undefined> {
  try {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(FLEET_DATA_DIR);
    const profile = await store.get(instanceId);
    return profile?.tenantId;
  } catch {
    return undefined;
  }
}

snapshotRoutes.post("/", writeAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  // Validate tenant ownership of the instance
  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const userId = c.req.header("X-User-Id") || "system";
  const tierHeader = c.req.header("X-Tier") || "free";

  const tier = tierSchema.safeParse(tierHeader);
  if (!tier.success) {
    return c.json({ error: "Invalid tier" }, 400);
  }

  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = createSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Only free tier is restricted to manual triggers
  if (tier.data === "free" && parsed.data.trigger !== "manual") {
    return c.json({ error: "Free tier only supports manual snapshots" }, 403);
  }

  const woprHomePath = `${WOPR_HOME_BASE}/${instanceId}`;
  const manager = getManager();

  try {
    const snapshot = await manager.create({
      instanceId,
      userId,
      woprHomePath,
      trigger: parsed.data.trigger,
    });

    // Enforce retention after creating
    await enforceRetention(manager, instanceId, tier.data);

    return c.json(snapshot, 201);
  } catch (err) {
    logger.error(`Failed to create snapshot for instance ${instanceId}`, { err });
    return c.json({ error: "Failed to create snapshot" }, 500);
  }
});

/** GET /api/instances/:id/snapshots -- List snapshots */
snapshotRoutes.get("/", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  // Validate tenant ownership of the instance
  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const snapshots = getManager().list(instanceId);
  return c.json({ snapshots });
});

/** POST /api/instances/:id/snapshots/:sid/restore -- Restore from snapshot */
snapshotRoutes.post("/:sid/restore", writeAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  const snapshotId = c.req.param("sid");
  if (!SAFE_ID_RE.test(instanceId) || !SAFE_ID_RE.test(snapshotId)) {
    return c.json({ error: "Invalid instance or snapshot ID" }, 400);
  }

  // Validate tenant ownership of the instance
  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const woprHomePath = `${WOPR_HOME_BASE}/${instanceId}`;
  const manager = getManager();

  // Verify the snapshot belongs to this instance
  const snapshot = manager.get(snapshotId);
  if (!snapshot) {
    return c.json({ error: `Snapshot not found: ${snapshotId}` }, 404);
  }
  if (snapshot.instanceId !== instanceId) {
    return c.json({ error: "Snapshot does not belong to this instance" }, 403);
  }

  try {
    await manager.restore(snapshotId, woprHomePath);
    return c.json({ ok: true, restored: snapshotId });
  } catch (err) {
    if (err instanceof SnapshotNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    logger.error(`Failed to restore snapshot ${snapshotId}`, { err });
    return c.json({ error: "Failed to restore snapshot" }, 500);
  }
});

/** DELETE /api/instances/:id/snapshots/:sid -- Delete a snapshot */
snapshotRoutes.delete("/:sid", writeAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  const snapshotId = c.req.param("sid");
  if (!SAFE_ID_RE.test(instanceId) || !SAFE_ID_RE.test(snapshotId)) {
    return c.json({ error: "Invalid instance or snapshot ID" }, 400);
  }

  // Validate tenant ownership of the instance
  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const manager = getManager();

  // Verify the snapshot belongs to this instance
  const snapshot = manager.get(snapshotId);
  if (!snapshot) {
    return c.json({ error: `Snapshot not found: ${snapshotId}` }, 404);
  }
  if (snapshot.instanceId !== instanceId) {
    return c.json({ error: "Snapshot does not belong to this instance" }, 403);
  }

  const deleted = await manager.delete(snapshotId);
  if (!deleted) {
    return c.json({ error: `Snapshot not found: ${snapshotId}` }, 404);
  }

  return c.body(null, 204);
});

/** Export for testing */
export { getManager };
