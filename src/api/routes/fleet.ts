import Database from "better-sqlite3";
import Docker from "dockerode";
import { Hono } from "hono";
import { z } from "zod";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../config/logger.js";
import { requireEmailVerified } from "../../email/require-verified.js";
import { CAPABILITY_ENV_MAP } from "../../fleet/capability-env-map.js";
import { BotNotFoundError, FleetManager } from "../../fleet/fleet-manager.js";
import { ImagePoller } from "../../fleet/image-poller.js";
import { defaultTemplatesDir, loadProfileTemplates } from "../../fleet/profile-loader.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { getRecoveryOrchestrator } from "../../fleet/services.js";
import { createBotSchema, updateBotSchema } from "../../fleet/types.js";
import { ContainerUpdater } from "../../fleet/updater.js";
import type { IBotBilling } from "../../monetization/credits/bot-billing.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import { checkInstanceQuota, DEFAULT_INSTANCE_LIMITS } from "../../monetization/quotas/quota-check.js";
import { buildResourceLimits } from "../../monetization/quotas/resource-limits.js";
import { NetworkPolicy } from "../../network/network-policy.js";
import { getProxyManager } from "../../proxy/singleton.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || "/data/platform/auth.db";

let _authDb: Database.Database | null = null;
function getAuthDb(): Database.Database {
  if (!_authDb) {
    _authDb = new Database(AUTH_DB_PATH);
    _authDb.pragma("journal_mode = WAL");
  }
  return _authDb;
}

const emailVerified = requireEmailVerified(getAuthDb);

const docker = new Docker();
const store = new ProfileStore(DATA_DIR);
const networkPolicy = new NetworkPolicy(docker);
const fleet = new FleetManager(docker, store, config.discovery, networkPolicy, getProxyManager());
const imagePoller = new ImagePoller(docker, store);
const updater = new ContainerUpdater(docker, store, fleet, imagePoller);

// ---------------------------------------------------------------------------
// Injected billing deps — set via setFleetDeps() before the server starts.
// ---------------------------------------------------------------------------

export interface FleetRouteDeps {
  creditLedger: ICreditLedger;
  botBilling: IBotBilling;
}

let _deps: FleetRouteDeps | null = null;

export function setFleetDeps(deps: FleetRouteDeps): void {
  _deps = deps;
}

function getDeps(): FleetRouteDeps {
  if (!_deps) {
    throw new Error("Fleet route deps not initialized — call setFleetDeps() before serving requests");
  }
  return _deps;
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

/** Parse Docker log output into structured LogEntry objects. */
function parseLogLines(
  raw: string,
): { id: string; timestamp: string; level: string; source: string; message: string }[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, i) => {
      // Try structured format: "2026-01-01T00:00:00Z [LEVEL] message"
      const match = line.match(/^(\S+)\s+\[(\w+)]\s+(.*)$/);
      if (match) {
        const level = match[2].toLowerCase();
        return {
          id: `log-${i}`,
          timestamp: match[1],
          level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
          source: "container",
          message: match[3],
        };
      }
      // Try Docker timestamp prefix: "2026-01-01T00:00:00.000Z some message"
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/);
      if (tsMatch) {
        return {
          id: `log-${i}`,
          timestamp: tsMatch[1],
          level: "info",
          source: "container",
          message: tsMatch[2],
        };
      }
      // Plain line
      return {
        id: `log-${i}`,
        timestamp: new Date().toISOString(),
        level: "info",
        source: "container",
        message: line,
      };
    });
}

// BOUNDARY(WOP-805): REST fleet routes have a tRPC mirror at src/trpc/routers/fleet.ts.
// The tRPC fleet router covers: listInstances, getInstance, createInstance,
// controlInstance, getInstanceHealth, getInstanceLogs, getInstanceMetrics, listTemplates.
//
// REST fleet routes have additional functionality NOT in tRPC:
//   - PATCH /fleet/bots/:id (update) — tRPC fleet router does NOT have update
//   - DELETE /fleet/bots/:id (remove) — tRPC fleet router does NOT have remove
//   - POST /fleet/bots/:id/update (image update) — tRPC fleet router does NOT have this
//   - GET /fleet/bots/:id/image-status — tRPC fleet router does NOT have this
//   - POST /fleet/seed — tRPC fleet router does NOT have seed
//   - Proxy registration side effects are now centralized in FleetManager (WOP-917)
//
// Keep REST fleet routes for:
//   1. CLI/SDK consumers that use bearer token auth (not session cookies)
//   2. The additional operations not yet in tRPC (update, remove, image-update, seed)
//
// UI migration: once wopr-platform-ui switches from fleetFetch() to tRPC fleet.*,
// REST fleet routes become SDK-only. The missing tRPC procedures (update, remove,
// image-update) should be added to the tRPC fleet router at that time.
export const fleetRoutes = new Hono();

// Build scoped token metadata map from environment
const tokenMetadataMap = buildTokenMetadataMap();
if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured — fleet routes will reject all requests");
}

// Read-scoped auth for GET endpoints
const readAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "read");
// Write-scoped auth for mutating endpoints
const writeAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "write");

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

/** GET /fleet/bots — List bots for the authenticated tenant */
fleetRoutes.get("/bots", readAuth, async (c) => {
  const tokenTenantId = c.get("tokenTenantId");
  let bots: Awaited<ReturnType<typeof fleet.listAll>>;
  if (tokenTenantId) {
    bots = await fleet.listByTenant(tokenTenantId);
  } else {
    bots = await fleet.listAll();
  }
  return c.json({ bots });
});

/** POST /fleet/bots — Create a new bot from profile config */
fleetRoutes.post("/bots", writeAuth, emailVerified, async (c) => {
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

  // Validate tenant ID matches the authenticated token (for tenant-scoped tokens)
  const tokenTenantId = c.get("tokenTenantId");
  if (tokenTenantId && parsed.data.tenantId !== tokenTenantId) {
    return c.json({ error: "Cannot create bot for a different tenant" }, 403);
  }

  // Check credit balance before creating container (skip if billing DB unavailable)
  try {
    const tenantId = parsed.data.tenantId;

    // Payment gate (WOP-380): require minimum 17 cents (1 day of bot runtime)
    const balance = getDeps().creditLedger.balance(tenantId);
    if (balance < 17) {
      return c.json(
        {
          error: "insufficient_credits",
          balance,
          required: 17,
          buyUrl: "/dashboard/credits",
        },
        402,
      );
    }

    // Count active instances for this tenant
    const allProfiles = await fleet.profiles.list();
    const activeInstances = allProfiles.filter((p) => p.tenantId === tenantId).length;

    // Check instance quota (unlimited by default for credit users)
    const quotaResult = checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, activeInstances);
    if (!quotaResult.allowed) {
      return c.json(
        {
          error: quotaResult.reason || "Instance quota exceeded",
          currentInstances: quotaResult.currentInstances,
          maxInstances: quotaResult.maxInstances,
        },
        403,
      );
    }
  } catch (quotaErr) {
    // Billing DB not available (e.g., in tests) — skip quota enforcement
    logger.warn("Quota check skipped: billing DB unavailable", { err: quotaErr });
  }

  // Build default resource limits for bot container
  const resourceLimits = buildResourceLimits();

  try {
    const profile = await fleet.create(parsed.data, resourceLimits);

    // Register bot in billing system for lifecycle tracking
    try {
      getDeps().botBilling.registerBot(profile.id, parsed.data.tenantId, parsed.data.name);
    } catch (regErr) {
      logger.warn("Bot billing registration failed (non-fatal)", { botId: profile.id, err: regErr });
    }

    return c.json(profile, 201);
  } catch (err) {
    logger.error("Failed to create bot", { err });
    return c.json({ error: "Failed to create bot" }, 500);
  }
});

/** GET /fleet/bots/:id — Get bot details + health */
fleetRoutes.get("/bots/:id", readAuth, async (c) => {
  const botId = c.req.param("id");
  try {
    // Get bot profile to check tenant ownership
    const profile = await fleet.profiles.get(botId);

    // Validate tenant ownership
    const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
    if (ownershipError) {
      return ownershipError;
    }

    const status = await fleet.status(botId);
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** PATCH /fleet/bots/:id — Update bot config (triggers restart if running) */
fleetRoutes.patch("/bots/:id", writeAuth, async (c) => {
  const botId = c.req.param("id");

  // Check tenant ownership before allowing update
  const existingProfile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, existingProfile, existingProfile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

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
    const profile = await fleet.update(botId, parsed.data);
    return c.json(profile);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** DELETE /fleet/bots/:id — Stop and remove bot */
fleetRoutes.delete("/bots/:id", writeAuth, async (c) => {
  const botId = c.req.param("id");

  // Check tenant ownership before allowing deletion
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    await fleet.remove(botId, c.req.query("removeVolumes") === "true");

    // Capacity freed -- check if any waiting recovery tenants can now be placed
    Promise.resolve()
      .then(() => {
        // Retry any waiting recovery items now that capacity freed up
        const repo = getRecoveryOrchestrator();
        return repo
          .listEvents()
          .reduce((p, e) => p.then(() => repo.retryWaiting(e.id)), Promise.resolve(undefined as unknown));
      })
      .catch((err) => {
        logger.error("Auto-retry after bot removal failed", { err });
      });

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/start — Start a stopped bot */
fleetRoutes.post("/bots/:id/start", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  // Payment gate (WOP-380): require minimum 17 cents to start a bot
  try {
    const tenantId = profile?.tenantId;
    if (!tenantId) return c.json({ error: "Missing tenant" }, 400);
    const balance = getDeps().creditLedger.balance(tenantId);
    if (balance < 17) {
      return c.json(
        {
          error: "insufficient_credits",
          balance,
          required: 17,
          buyUrl: "/dashboard/credits",
        },
        402,
      );
    }
  } catch (err) {
    logger.warn("Credit check skipped on bot start: billing DB unavailable", { err });
  }

  try {
    await fleet.start(botId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/stop — Stop a running bot */
fleetRoutes.post("/bots/:id/stop", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    await fleet.stop(botId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/restart — Restart a running bot */
fleetRoutes.post("/bots/:id/restart", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    await fleet.restart(botId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/health — Per-bot health (state, uptime, CPU, memory) */
fleetRoutes.get("/bots/:id/health", readAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    const status = await fleet.status(botId);
    return c.json({
      id: status.id,
      state: status.state,
      health: status.health,
      uptime: status.uptime,
      stats: status.stats,
    });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/metrics — Per-bot resource metrics (CPU, memory) */
fleetRoutes.get("/bots/:id/metrics", readAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    const status = await fleet.status(botId);
    return c.json({
      id: status.id,
      stats: status.stats,
    });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/logs — Tail bot container logs (returns structured JSON) */
fleetRoutes.get("/bots/:id/logs", readAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const raw = c.req.query("tail");
  const parsed = raw != null ? Number.parseInt(raw, 10) : 100;
  const tail = Number.isNaN(parsed) || parsed < 1 ? 100 : Math.min(parsed, 10_000);
  try {
    const logs = await fleet.logs(botId, tail);
    return c.json(parseLogLines(logs));
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/update — Force update to latest image */
fleetRoutes.post("/bots/:id/update", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    const result = await updater.updateBot(botId);
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
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  // If we reach here, profile cannot be null (validated above)
  if (!profile) {
    return c.json({ error: "Bot not found" }, 404);
  }

  try {
    const status = imagePoller.getImageStatus(botId, profile);
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

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

fleetRoutes.post("/seed", writeAuth, async (c) => {
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

  const profiles = await fleet.profiles.list();
  const existingNames = new Set(profiles.map((p) => p.name));
  const result = seedBots(templates, existingNames);
  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// Capability / identity helpers (shared between REST routes below)
// ---------------------------------------------------------------------------

/** GET /fleet/bots/:id/settings — Full bot settings (identity + capabilities + plugins + status) */
fleetRoutes.get("/bots/:id/settings", readAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  // Get live status
  let botState: "running" | "stopped" | "archived" = "stopped";
  try {
    const status = await fleet.status(botId);
    botState = status.state === "running" ? "running" : "stopped";
  } catch (err) {
    if (!(err instanceof BotNotFoundError)) throw err;
  }

  const pluginIds = (profile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const disabledSet = new Set(
    (profile.env.WOPR_PLUGINS_DISABLED || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const hostedKeys = new Set(
    (profile.env.WOPR_HOSTED_KEYS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const activeSuperpowers: Array<Record<string, unknown>> = [];
  const activeCapabilityIds = new Set<string>();

  for (const [capId, entry] of Object.entries(CAPABILITY_ENV_MAP)) {
    if (profile.env[entry.envKey]) {
      activeCapabilityIds.add(capId);
      activeSuperpowers.push({
        id: capId,
        name: capId,
        icon: "zap",
        mode: hostedKeys.has(entry.envKey) ? "hosted" : "byok",
        provider: entry.vaultProvider,
        model: "",
        usageCount: 0,
        usageLabel: "0 calls",
        spend: 0,
      });
    }
  }

  return c.json({
    id: profile.id,
    identity: { name: profile.name, avatar: "", personality: "" },
    brain: {
      provider: profile.env.WOPR_LLM_PROVIDER || "none",
      model: profile.env.WOPR_LLM_MODEL || "none",
      mode: hostedKeys.has("OPENROUTER_API_KEY") ? "hosted" : "byok",
      costPerMessage: "~$0.001",
      description: "",
    },
    channels: [],
    availableChannels: [],
    activeSuperpowers,
    availableSuperpowers: Object.keys(CAPABILITY_ENV_MAP)
      .filter((id) => !activeCapabilityIds.has(id))
      .map((id) => ({
        id,
        name: id,
        icon: "zap",
        description: `Add ${id} capability to your bot`,
        pricing: "Usage-based",
      })),
    installedPlugins: pluginIds.map((id) => ({
      id,
      name: id,
      description: "",
      icon: "",
      status: disabledSet.has(id) ? "disabled" : "active",
      capabilities: [],
    })),
    discoverPlugins: [],
    usage: { totalSpend: 0, creditBalance: 0, capabilities: [], trend: [] },
    status: botState,
  });
});

/** PUT /fleet/bots/:id/identity — Update bot name/avatar/personality */
fleetRoutes.put("/bots/:id/identity", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = z
    .object({
      name: z.string().min(1).max(63),
      avatar: z.string().max(2048).default(""),
      personality: z.string().max(4096).default(""),
    })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  try {
    const updated = await fleet.update(botId, {
      name: parsed.data.name,
      description: parsed.data.personality,
    });
    return c.json({ name: updated.name, avatar: parsed.data.avatar, personality: updated.description });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/capabilities/:capabilityId/activate — Activate a superpower */
fleetRoutes.post("/bots/:id/capabilities/:capabilityId/activate", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const capabilityId = c.req.param("capabilityId");

  const capEntry = CAPABILITY_ENV_MAP[capabilityId];
  if (!capEntry) {
    return c.json({ error: `Unknown capability: ${capabilityId}` }, 400);
  }

  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  const activeKey = `WOPR_CAP_${capabilityId.toUpperCase().replace(/-/g, "_")}_ACTIVE`;
  if (profile.env[activeKey]) {
    return c.json({ success: true, capabilityId, alreadyActive: true });
  }

  try {
    await fleet.update(botId, {
      env: {
        ...profile.env,
        [activeKey]: "1",
      },
    });
    return c.json({ success: true, capabilityId, alreadyActive: false });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/upgrade-to-vps — Initiate VPS upgrade via Stripe subscription checkout */
fleetRoutes.post("/bots/:id/upgrade-to-vps", writeAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  const vpsPriceId = process.env.STRIPE_VPS_PRICE_ID;
  if (!vpsPriceId) {
    return c.json({ error: "VPS tier not configured" }, 503);
  }

  const { getVpsRepo, getTenantCustomerStore } = await import("../../fleet/services.js");
  const vpsRepo = getVpsRepo();
  const existing = vpsRepo.getByBotId(botId);
  if (existing && existing.status === "active") {
    return c.json({ error: "Bot already on VPS tier" }, 409);
  }

  const tenantStore = getTenantCustomerStore();
  const customer = tenantStore.getByTenant(profile.tenantId);
  if (!customer) {
    return c.json(
      {
        error: "No payment method on file. Please add a payment method first.",
        buyUrl: "/dashboard/billing",
      },
      402,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // No body is fine — use defaults
  }

  const baseUrl = process.env.PLATFORM_UI_URL ?? "https://app.wopr.bot";
  const successUrl =
    typeof body.successUrl === "string" ? body.successUrl : `${baseUrl}/dashboard/bots/${botId}?vps=activated`;
  const cancelUrl = typeof body.cancelUrl === "string" ? body.cancelUrl : `${baseUrl}/dashboard/bots/${botId}`;

  const { createVpsCheckoutSession } = await import("../../monetization/stripe/checkout.js");
  const { createStripeClient, loadStripeConfig } = await import("../../monetization/stripe/client.js");

  const stripeConfig = loadStripeConfig();
  if (!stripeConfig) {
    return c.json({ error: "Stripe not configured" }, 503);
  }

  const session = await createVpsCheckoutSession(createStripeClient(stripeConfig), tenantStore, {
    tenant: profile.tenantId,
    botId,
    vpsPriceId,
    successUrl,
    cancelUrl,
  });

  return c.json({ url: session.url, sessionId: session.id });
});

/** GET /fleet/bots/:id/vps-info — Get VPS subscription info for a bot */
fleetRoutes.get("/bots/:id/vps-info", readAuth, async (c) => {
  const botId = c.req.param("id");
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  const { getVpsRepo } = await import("../../fleet/services.js");
  const sub = getVpsRepo().getByBotId(botId);
  if (!sub) {
    return c.json({ error: "Bot is not on VPS tier" }, 404);
  }

  const sshConnectionString = sub.sshPublicKey ? `ssh root@${sub.hostname ?? `${botId}.bot.wopr.bot`} -p 22` : null;

  return c.json({
    botId: sub.botId,
    status: sub.status,
    hostname: sub.hostname,
    sshConnectionString,
    diskSizeGb: sub.diskSizeGb,
    createdAt: sub.createdAt,
  });
});

/** Export fleet manager and related modules for testing */
export { fleet, FleetManager, imagePoller, updater };
