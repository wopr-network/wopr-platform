import Database from "better-sqlite3";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { logger } from "../../config/logger.js";
import { buildQuotaUsage, checkInstanceQuota } from "../../monetization/quotas/quota-check.js";
import { buildResourceLimits } from "../../monetization/quotas/resource-limits.js";
import { TierStore } from "../../monetization/quotas/tier-definitions.js";

const DB_PATH = process.env.QUOTA_DB_PATH || "/data/platform/quotas.db";
const FLEET_API_TOKEN = process.env.FLEET_API_TOKEN;

/**
 * Create the quota database and tier store.
 * Exported for testing — callers can pass an in-memory DB.
 */
export function createTierStore(db?: Database.Database): TierStore {
  const database = db ?? new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  const store = new TierStore(database);
  store.seed();
  return store;
}

export const quotaRoutes = new Hono();

// Auth — same token as fleet for now
if (!FLEET_API_TOKEN) {
  logger.warn("FLEET_API_TOKEN is not set — quota routes will reject all requests");
}
quotaRoutes.use("/*", bearerAuth({ token: FLEET_API_TOKEN || "" }));

let tierStore: TierStore | null = null;

function getTierStore(): TierStore {
  if (!tierStore) {
    tierStore = createTierStore();
  }
  return tierStore;
}

/** Inject a TierStore for testing */
export function setTierStore(store: TierStore): void {
  tierStore = store;
}

/**
 * GET /quota
 *
 * Returns the authenticated user's quota usage vs limits.
 * For now, the user's tier is passed via query param `tier` (default: free).
 * In production this will come from the auth session/organization.
 *
 * Query params:
 *   - tier: tier ID (default: "free")
 *   - activeInstances: current instance count (temporary — will come from fleet DB)
 */
quotaRoutes.get("/", (c) => {
  const tierId = c.req.query("tier") || "free";
  const activeRaw = c.req.query("activeInstances");
  const activeInstances = activeRaw != null ? Number.parseInt(activeRaw, 10) : 0;

  if (Number.isNaN(activeInstances) || activeInstances < 0) {
    return c.json({ error: "Invalid activeInstances parameter" }, 400);
  }

  const store = getTierStore();
  const tier = store.get(tierId);
  if (!tier) {
    return c.json({ error: `Unknown tier: ${tierId}` }, 404);
  }

  const usage = buildQuotaUsage(tier, activeInstances);
  return c.json(usage);
});

/**
 * POST /quota/check
 *
 * Check whether an instance creation would be allowed.
 * Body: { tier?: string, activeInstances: number, softCap?: boolean }
 */
quotaRoutes.post("/check", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tierId = (body.tier as string) || "free";
  const activeInstances = Number(body.activeInstances ?? 0);
  const softCap = Boolean(body.softCap);

  if (Number.isNaN(activeInstances) || activeInstances < 0) {
    return c.json({ error: "Invalid activeInstances" }, 400);
  }

  const store = getTierStore();
  const tier = store.get(tierId);
  if (!tier) {
    return c.json({ error: `Unknown tier: ${tierId}` }, 404);
  }

  const result = checkInstanceQuota(tier, activeInstances, {
    softCapEnabled: softCap,
    gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
  });

  const status = result.allowed ? 200 : 403;
  return c.json(result, status);
});

/**
 * GET /quota/tiers
 *
 * List all available plan tiers.
 */
quotaRoutes.get("/tiers", (c) => {
  const store = getTierStore();
  const tiers = store.list();
  return c.json({ tiers });
});

/**
 * GET /quota/tiers/:id
 *
 * Get a specific tier's details.
 */
quotaRoutes.get("/tiers/:id", (c) => {
  const store = getTierStore();
  const tier = store.get(c.req.param("id"));
  if (!tier) {
    return c.json({ error: `Unknown tier: ${c.req.param("id")}` }, 404);
  }
  return c.json(tier);
});

/**
 * GET /quota/resource-limits/:tierId
 *
 * Get Docker resource constraints for a specific tier.
 */
quotaRoutes.get("/resource-limits/:tierId", (c) => {
  const store = getTierStore();
  const tier = store.get(c.req.param("tierId"));
  if (!tier) {
    return c.json({ error: `Unknown tier: ${c.req.param("tierId")}` }, 404);
  }

  const limits = buildResourceLimits(tier);
  return c.json(limits);
});
