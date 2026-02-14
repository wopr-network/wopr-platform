import Database from "better-sqlite3";
import Docker from "dockerode";
import { Hono } from "hono";
import { buildTokenMap, scopedBearerAuth } from "../../auth/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../config/logger.js";
import { BotNotFoundError, FleetManager } from "../../fleet/fleet-manager.js";
import { ImagePoller } from "../../fleet/image-poller.js";
import { defaultTemplatesDir, loadProfileTemplates } from "../../fleet/profile-loader.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { createBotSchema, updateBotSchema } from "../../fleet/types.js";
import { ContainerUpdater } from "../../fleet/updater.js";
import { checkInstanceQuota } from "../../monetization/quotas/quota-check.js";
import { TierStore } from "../../monetization/quotas/tier-definitions.js";
import { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";
import { NetworkPolicy } from "../../network/network-policy.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const BILLING_DB_PATH = process.env.BILLING_DB_PATH || "/data/platform/billing.db";
const QUOTA_DB_PATH = process.env.QUOTA_DB_PATH || "/data/platform/quotas.db";

const docker = new Docker();
const store = new ProfileStore(DATA_DIR);
const networkPolicy = new NetworkPolicy(docker);
const fleet = new FleetManager(docker, store, config.discovery, networkPolicy);
const imagePoller = new ImagePoller(docker, store);
const updater = new ContainerUpdater(docker, store, fleet, imagePoller);

// Initialize billing and quota stores for tenant tier lookups
let billingDb: Database.Database | null = null;
let quotaDb: Database.Database | null = null;
let tenantStore: TenantCustomerStore | null = null;
let tierStore: TierStore | null = null;

function getBillingDb(): Database.Database {
  if (!billingDb) {
    billingDb = new Database(BILLING_DB_PATH);
    billingDb.pragma("journal_mode = WAL");
  }
  return billingDb;
}

function getQuotaDb(): Database.Database {
  if (!quotaDb) {
    quotaDb = new Database(QUOTA_DB_PATH);
    quotaDb.pragma("journal_mode = WAL");
  }
  return quotaDb;
}

function getTenantStore(): TenantCustomerStore {
  if (!tenantStore) {
    tenantStore = new TenantCustomerStore(getBillingDb());
  }
  return tenantStore;
}

function getTierStore(): TierStore {
  if (!tierStore) {
    tierStore = new TierStore(getQuotaDb());
    tierStore.seed();
  }
  return tierStore;
}

// Wire up the poller to trigger updates via the updater
imagePoller.onUpdateAvailable = async (botId: string) => {
  try {
    const result = await updater.updateBot(botId);
    if (result.success) {
      logger.info(`Auto-updated bot ${botId}`);
    } else {
      logger.warn(`Auto-update failed for bot ${botId}: ${result.error}`);
    }
  } catch (err) {
    logger.error(`Auto-update error for bot ${botId}`, { err });
  }
};

/** UUID v4 format (lowercase hex with dashes). */
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const fleetRoutes = new Hono();

// Build scoped token map from environment
const tokenMap = buildTokenMap();
if (tokenMap.size === 0) {
  logger.warn("No API tokens configured — fleet routes will reject all requests");
}

// Read-scoped auth for GET endpoints
const readAuth = scopedBearerAuth(tokenMap, "read");
// Write-scoped auth for mutating endpoints
const writeAuth = scopedBearerAuth(tokenMap, "write");

/** Validate :id param as UUID on all /bots/:id routes. */
fleetRoutes.use("/bots/:id/*", async (c, next) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }
  return next();
});
fleetRoutes.use("/bots/:id", async (c, next) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }
  return next();
});

/** GET /fleet/bots — List all bots with live status */
fleetRoutes.get("/bots", readAuth, async (c) => {
  const bots = await fleet.listAll();
  return c.json({ bots });
});

/** POST /fleet/bots — Create a new bot from profile config */
fleetRoutes.post("/bots", writeAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createBotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Check instance quota before creating container
  const tenantId = parsed.data.tenantId;

  // Get tenant's tier (defaults to "free" if not found)
  const tenantMapping = getTenantStore().getByTenant(tenantId);
  const tierId = tenantMapping?.tier ?? "free";

  // Get tier definition
  const tier = getTierStore().get(tierId);
  if (!tier) {
    logger.error(`Unknown tier: ${tierId} for tenant ${tenantId}`);
    return c.json({ error: "Internal error: invalid tier configuration" }, 500);
  }

  // Count active instances for this tenant
  const allProfiles = await fleet.profiles.list();
  const activeInstances = allProfiles.filter((p) => p.tenantId === tenantId).length;

  // Check quota
  const quotaResult = checkInstanceQuota(tier, activeInstances);
  if (!quotaResult.allowed) {
    return c.json(
      {
        error: quotaResult.reason || "Instance quota exceeded for your plan tier",
        currentInstances: quotaResult.currentInstances,
        maxInstances: quotaResult.maxInstances,
        tier: tier.name,
      },
      403,
    );
  }

  try {
    const profile = await fleet.create(parsed.data);
    return c.json(profile, 201);
  } catch (err) {
    logger.error("Failed to create bot", { err });
    return c.json({ error: "Failed to create bot" }, 500);
  }
});

/** GET /fleet/bots/:id — Get bot details + health */
fleetRoutes.get("/bots/:id", readAuth, async (c) => {
  try {
    const status = await fleet.status(c.req.param("id"));
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** PATCH /fleet/bots/:id — Update bot config (triggers restart if running) */
fleetRoutes.patch("/bots/:id", writeAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateBotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Reject empty updates
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  try {
    const profile = await fleet.update(c.req.param("id"), parsed.data);
    return c.json(profile);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** DELETE /fleet/bots/:id — Stop and remove bot */
fleetRoutes.delete("/bots/:id", writeAuth, async (c) => {
  try {
    await fleet.remove(c.req.param("id"), c.req.query("removeVolumes") === "true");
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/start — Start a stopped bot */
fleetRoutes.post("/bots/:id/start", writeAuth, async (c) => {
  try {
    await fleet.start(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/stop — Stop a running bot */
fleetRoutes.post("/bots/:id/stop", writeAuth, async (c) => {
  try {
    await fleet.stop(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/restart — Restart a running bot */
fleetRoutes.post("/bots/:id/restart", writeAuth, async (c) => {
  try {
    await fleet.restart(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/logs — Tail bot container logs */
fleetRoutes.get("/bots/:id/logs", readAuth, async (c) => {
  const raw = c.req.query("tail");
  const parsed = raw != null ? Number.parseInt(raw, 10) : 100;
  const tail = Number.isNaN(parsed) || parsed < 1 ? 100 : Math.min(parsed, 10_000);
  try {
    const logs = await fleet.logs(c.req.param("id"), tail);
    return c.text(logs);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/update — Force update to latest image */
fleetRoutes.post("/bots/:id/update", writeAuth, async (c) => {
  try {
    const result = await updater.updateBot(c.req.param("id"));
    if (result.success) {
      return c.json(result);
    }
    return c.json(result, result.error === "Bot not found" ? 404 : 500);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/image-status — Current vs available digest + last check time */
fleetRoutes.get("/bots/:id/image-status", readAuth, async (c) => {
  const botId = c.req.param("id");
  try {
    const profile = await fleet.profiles.get(botId);
    if (!profile) return c.json({ error: `Bot not found: ${botId}` }, 404);

    const status = imagePoller.getImageStatus(botId, profile);
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** In-memory set of bot names that have been seeded (placeholder until fleet manager provides real storage) */
const seededBots = new Set<string>();

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Seed bots from profile templates.
 * @param templates - Parsed profile templates to seed from.
 * @param existingNames - Set of bot names that already exist (mutated in place).
 */
export function seedBots(templates: ProfileTemplate[], existingNames: Set<string>): SeedResult {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const template of templates) {
    if (existingNames.has(template.name)) {
      skipped.push(template.name);
    } else {
      existingNames.add(template.name);
      created.push(template.name);
    }
  }

  return { created, skipped };
}

fleetRoutes.post("/seed", writeAuth, (c) => {
  const templatesDir = defaultTemplatesDir();

  let templates: ProfileTemplate[];
  try {
    templates = loadProfileTemplates(templatesDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load templates";
    return c.json({ error: message }, 500);
  }

  if (templates.length === 0) {
    return c.json({ error: "No templates found" }, 404);
  }

  const result = seedBots(templates, seededBots);
  return c.json(result, 200);
});

/** Export fleet manager and related modules for testing */
export { fleet, FleetManager, imagePoller, updater };
