import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import {
  InsufficientCreditsError,
  type OnDemandSnapshotService,
  SnapshotQuotaExceededError,
} from "../../backup/on-demand-snapshot-service.js";
import { createOnDemandSnapshotSchema, tierSchema } from "../../backup/types.js";
import { logger } from "../../config/logger.js";
import type { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";

/** Only allow safe characters in IDs used for filesystem paths. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

const metadataMap = buildTokenMetadataMap();
const readAuth = scopedBearerAuthWithTenant(metadataMap, "read");
const writeAuth = scopedBearerAuthWithTenant(metadataMap, "write");

export const botSnapshotRoutes = new Hono<AuthEnv>();

if (metadataMap.size === 0) {
  logger.warn("No API tokens configured -- bot snapshot routes will reject all requests");
}

// Lazy-initialized service
let _service: OnDemandSnapshotService | null = null;
let _tenantStore: TenantCustomerStore | null = null;

function getService(): OnDemandSnapshotService {
  if (!_service) {
    throw new Error("OnDemandSnapshotService not initialized -- call initBotSnapshotRoutes() first");
  }
  return _service;
}

function getTenantStore(): TenantCustomerStore | null {
  return _tenantStore;
}

/** Initialize the service with runtime dependencies. */
export function initBotSnapshotRoutes(service: OnDemandSnapshotService, tenantStore?: TenantCustomerStore): void {
  _service = service;
  _tenantStore = tenantStore ?? null;
}

/** Export for testing */
export function setService(service: OnDemandSnapshotService | null, tenantStore?: TenantCustomerStore | null): void {
  _service = service;
  _tenantStore = tenantStore ?? null;
}

/**
 * POST /api/bots/:id/snapshots -- Create an on-demand snapshot
 */
botSnapshotRoutes.post("/", writeAuth, async (c) => {
  const botId = c.req.param("id");
  if (!SAFE_ID_RE.test(botId)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }

  // Parse body
  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = createOnDemandSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Resolve tenant from token
  let tenantId: string | undefined;
  try {
    tenantId = c.get("tokenTenantId");
  } catch {
    // not set
  }
  if (!tenantId) {
    return c.json({ error: "Tenant not identified" }, 401);
  }

  // Read tier from authenticated tenant record in DB — never trust the client-supplied header
  const store = getTenantStore();
  const tenantRecord = (await store?.getByTenant(tenantId)) ?? null;
  const rawTier = tenantRecord?.tier ?? "free";
  const tier = tierSchema.safeParse(rawTier);
  if (!tier.success) {
    return c.json({ error: "Invalid tier" }, 400);
  }

  let userId = "system";
  try {
    const user = c.get("user");
    if (user?.id) userId = user.id;
  } catch {
    // Defensive fallback — should never happen on authenticated routes
  }
  const woprHomePath = `${process.env.WOPR_HOME_BASE || "/data/instances"}/${botId}`;

  const service = getService();

  try {
    const result = await service.create({
      tenant: tenantId,
      instanceId: botId,
      userId,
      woprHomePath,
      name: parsed.data.name,
      tier: tier.data,
    });

    return c.json(
      {
        snapshot: result.snapshot,
        estimatedMonthlyCost: `$${(result.estimatedMonthlyCostCents / 100).toFixed(2)}/month`,
      },
      201,
    );
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return c.json({ error: "insufficient_credits", balance: err.balance, buyUrl: "/dashboard/credits" }, 402);
    }
    if (err instanceof SnapshotQuotaExceededError) {
      return c.json({ error: "snapshot_quota_exceeded", current: err.current, max: err.max, tier: err.tier }, 403);
    }
    logger.error(`Failed to create snapshot for bot ${botId}`, { err });
    return c.json({ error: "Failed to create snapshot" }, 500);
  }
});

/**
 * GET /api/bots/:id/snapshots -- List all snapshots (nightly + on-demand)
 */
botSnapshotRoutes.get("/", readAuth, async (c) => {
  const botId = c.req.param("id");
  if (!SAFE_ID_RE.test(botId)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }

  let tenantId: string | undefined;
  try {
    tenantId = c.get("tokenTenantId");
  } catch {
    // not set
  }
  if (!tenantId) {
    return c.json({ error: "Tenant not identified" }, 401);
  }

  const service = getService();
  const snaps = service.list(tenantId, botId);

  return c.json({ snapshots: snaps });
});

/**
 * DELETE /api/bots/:id/snapshots/:snapId -- Delete an on-demand snapshot
 */
botSnapshotRoutes.delete("/:snapId", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const snapId = c.req.param("snapId");
  if (!SAFE_ID_RE.test(botId) || !SAFE_ID_RE.test(snapId)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  let tenantId: string | undefined;
  try {
    tenantId = c.get("tokenTenantId");
  } catch {
    // not set
  }
  if (!tenantId) {
    return c.json({ error: "Tenant not identified" }, 401);
  }

  const service = getService();

  try {
    const deleted = await service.delete(snapId, tenantId);
    if (!deleted) {
      return c.json({ error: "Snapshot not found" }, 404);
    }
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Only on-demand")) {
      return c.json({ error: "Only on-demand snapshots can be deleted" }, 403);
    }
    logger.error(`Failed to delete snapshot ${snapId}`, { err });
    return c.json({ error: "Failed to delete snapshot" }, 500);
  }
});
