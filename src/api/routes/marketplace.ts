// src/api/routes/marketplace.ts
import { Hono } from "hono";
import { z } from "zod";
import type { AuditEnv } from "../../audit/types.js";
import { logger } from "../../config/logger.js";
import { lookupCapabilityEnv } from "../../fleet/capability-env-map.js";
import { BotNotFoundError } from "../../fleet/fleet-manager.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { getMarketplaceContentRepo, getMarketplacePluginRepo } from "../../fleet/services.js";
import { Credit } from "../../monetization/credit.js";
import type { MeterEvent } from "../../monetization/metering/types.js";
import type { DecryptedCredential } from "../../security/credential-vault/store.js";
import { fleet } from "./fleet.js";
import { type PluginCategory, type PluginManifest, pluginRegistry } from "./marketplace-registry.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const store = new ProfileStore(DATA_DIR);

// Dependencies injected for hosted credential resolution.
// In production these are set by the app bootstrap; tests mock them.
let credentialVault: {
  getActiveForProvider(provider: string): Promise<Array<Pick<DecryptedCredential, "plaintextKey">>>;
} | null = null;
let meterEmitter: { emit(event: MeterEvent): void } | null = null;

export function setMarketplaceDeps(deps: {
  credentialVault: typeof credentialVault;
  meterEmitter: typeof meterEmitter;
}): void {
  credentialVault = deps.credentialVault;
  meterEmitter = deps.meterEmitter;
}

// BOUNDARY(WOP-805): This REST route is a tRPC migration candidate.
// The UI calls GET /api/marketplace/plugins via session cookie. Should become
// tRPC procedures (marketplace.list, marketplace.get, marketplace.install).
// Blocker: none — straightforward migration.
export const marketplaceRoutes = new Hono<AuditEnv>();

/**
 * GET /api/marketplace/plugins
 *
 * List all available plugins in the marketplace.
 * Query params:
 *   - category: filter by plugin category
 *   - search: search by name/description/tags
 */
marketplaceRoutes.get("/plugins", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  let merged: PluginManifest[];
  try {
    const repo = getMarketplacePluginRepo();
    const dbPlugins = await repo.findEnabled();
    const staticById = new Map(pluginRegistry.map((p) => [p.id, p]));

    merged = dbPlugins.map((dbp) => {
      const staticManifest = staticById.get(dbp.pluginId);
      if (staticManifest) {
        return { ...staticManifest };
      }
      return {
        id: dbp.pluginId,
        name: dbp.npmPackage.replace(/^@wopr-network\/wopr-plugin-/, ""),
        description: dbp.notes ?? "",
        version: dbp.version,
        author: "Community",
        icon: "Package",
        color: "#6B7280",
        category: (dbp.category ?? "integration") as PluginCategory,
        tags: dbp.category ? [dbp.category] : [],
        capabilities: [],
        requires: [],
        install: [],
        configSchema: [],
        setup: [],
        installCount: 0,
        changelog: [],
      } satisfies PluginManifest;
    });

    // Include static plugins with no DB record (backwards compat for first-party plugins)
    for (const sp of pluginRegistry) {
      if (!dbPlugins.some((dbp) => dbp.pluginId === sp.id)) {
        merged.push(sp);
      }
    }
  } catch (err) {
    logger.error("Marketplace plugin repo unavailable", { err });
    return c.json({ error: "Service unavailable" }, 503);
  }

  const category = c.req.query("category");
  if (category) {
    merged = merged.filter((p) => p.category === category);
  }

  const search = c.req.query("search")?.toLowerCase();
  if (search) {
    merged = merged.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.description.toLowerCase().includes(search) ||
        p.tags.some((t) => t.includes(search)),
    );
  }

  return c.json(merged);
});

/**
 * GET /api/marketplace/plugins/:id
 *
 * Get a single plugin manifest by ID.
 */
marketplaceRoutes.get("/plugins/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");

  // Check static registry first (rich manifest)
  const staticPlugin = pluginRegistry.find((p) => p.id === id);
  if (staticPlugin) return c.json(staticPlugin);

  // Check DB for dynamic plugins
  try {
    const repo = getMarketplacePluginRepo();
    const dbPlugin = await repo.findById(id);
    if (dbPlugin) {
      return c.json({
        id: dbPlugin.pluginId,
        name: dbPlugin.npmPackage.replace(/^@wopr-network\/wopr-plugin-/, ""),
        description: dbPlugin.notes ?? "",
        version: dbPlugin.version,
        author: "Community",
        icon: "Package",
        color: "#6B7280",
        category: (dbPlugin.category ?? "integration") as PluginCategory,
        tags: dbPlugin.category ? [dbPlugin.category] : [],
        capabilities: [],
        requires: [],
        install: [],
        configSchema: [],
        setup: [],
        installCount: 0,
        changelog: [],
      } satisfies PluginManifest);
    }
  } catch (err) {
    logger.error("Marketplace plugin repo unavailable", { err });
    return c.json({ error: "Service unavailable" }, 503);
  }

  return c.json({ error: "Plugin not found" }, 404);
});

/**
 * GET /api/marketplace/plugins/:id/content
 *
 * Get the SUPERPOWER.md content (or fallback description) for a plugin.
 */
marketplaceRoutes.get("/plugins/:id/content", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");

  let plugin = pluginRegistry.find((p) => p.id === id);
  if (!plugin) {
    try {
      const repo = getMarketplacePluginRepo();
      const dbPlugin = await repo.findById(id);
      if (dbPlugin) {
        plugin = {
          id: dbPlugin.pluginId,
          name: dbPlugin.npmPackage.replace(/^@wopr-network\/wopr-plugin-/, ""),
          description: dbPlugin.notes ?? "",
          version: dbPlugin.version,
          author: "Community",
          icon: "Package",
          color: "#6B7280",
          category: (dbPlugin.category ?? "integration") as PluginCategory,
          tags: dbPlugin.category ? [dbPlugin.category] : [],
          capabilities: [],
          requires: [],
          install: [],
          configSchema: [],
          setup: [],
          installCount: 0,
          changelog: [],
        } satisfies PluginManifest;
      }
    } catch (err) {
      logger.error("Marketplace plugin repo unavailable", { err });
      return c.json({ error: "Service unavailable" }, 503);
    }
  }

  if (!plugin) return c.json({ error: "Plugin not found" }, 404);

  try {
    const contentRepo = getMarketplaceContentRepo();
    const cached = await contentRepo.getByPluginId(id);
    if (cached) {
      return c.json({ markdown: cached.markdown, source: cached.source, version: cached.version });
    }
  } catch (err) {
    logger.error("Marketplace content repo unavailable", { err });
    return c.json({ error: "Service unavailable" }, 503);
  }

  return c.json({
    markdown: plugin.description,
    source: "manifest_description" as const,
    version: plugin.version,
  });
});

const installSchema = z.object({
  botId: z.string().uuid("botId must be a valid UUID"),
  config: z.record(z.string(), z.unknown()).default({}),
  providerChoices: z.record(z.string(), z.enum(["byok", "hosted"])).default({}),
});

/**
 * POST /api/marketplace/plugins/:id/install
 *
 * Install a plugin on a bot. Requires a botId in the request body.
 * Validates session ownership, then delegates to the same install logic as bot-plugins.ts.
 */
marketplaceRoutes.post("/plugins/:id/install", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");

  // Check static registry first, then DB for dynamic plugins
  let pluginFound = pluginRegistry.some((p) => p.id === id);
  if (!pluginFound) {
    try {
      const repo = getMarketplacePluginRepo();
      const dbPlugin = await repo.findById(id);
      if (dbPlugin) pluginFound = true;
    } catch (err) {
      logger.error("Marketplace plugin repo unavailable during install", { err });
      return c.json({ error: "Service unavailable" }, 503);
    }
  }
  if (!pluginFound) return c.json({ error: "Plugin not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body or botId is required" }, 400);
  }

  const parsed = installSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed: botId must be a valid UUID", details: parsed.error.flatten() }, 400);
  }

  const { botId } = parsed.data;

  // Get bot profile and validate session ownership
  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  // Session auth: user.id IS the tenant ID — compare directly
  if (profile.tenantId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Re-fetch profile immediately before write to avoid clobbering concurrent installs
  const freshProfile = await store.get(botId);
  if (!freshProfile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  if (freshProfile.tenantId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Read existing WOPR_PLUGINS env var (comma-separated plugin IDs)
  const existingPlugins = (freshProfile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (existingPlugins.includes(id)) {
    return c.json({ error: "Plugin already installed", pluginId: id }, 409);
  }

  const updatedPlugins = [...existingPlugins, id].join(",");

  // Resolve hosted provider choices BEFORE writing to profile
  const hostedEnvVars: Record<string, string> = {};
  const hostedKeyNames: string[] = [];

  for (const [capability, choice] of Object.entries(parsed.data.providerChoices)) {
    if (choice !== "hosted") continue;

    const capEntry = lookupCapabilityEnv(capability);
    if (!capEntry) {
      return c.json({ error: `Unknown capability: ${capability}` }, 400);
    }

    if (!credentialVault) {
      return c.json({ error: "Credential vault not configured" }, 503);
    }

    const creds = await credentialVault.getActiveForProvider(capEntry.vaultProvider);
    if (creds.length === 0) {
      return c.json({ error: `No platform credential available for hosted capability: ${capability}` }, 503);
    }

    hostedEnvVars[capEntry.envKey] = creds[0].plaintextKey;
    hostedKeyNames.push(capEntry.envKey);
  }

  const existingHostedKeys = (freshProfile.env.WOPR_HOSTED_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allHostedKeys = [...new Set([...existingHostedKeys, ...hostedKeyNames])];

  const configEnvKey = `WOPR_PLUGIN_${id.toUpperCase().replace(/-/g, "_")}_CONFIG`;
  const updatedEnv: Record<string, string> = {
    ...freshProfile.env,
    WOPR_PLUGINS: updatedPlugins,
    [configEnvKey]: JSON.stringify({ config: parsed.data.config, providerChoices: parsed.data.providerChoices }),
    ...hostedEnvVars,
  };

  if (allHostedKeys.length > 0) {
    updatedEnv.WOPR_HOSTED_KEYS = allHostedKeys.join(",");
  }

  try {
    await fleet.update(botId, { env: updatedEnv });
  } catch (err) {
    if (err instanceof BotNotFoundError) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }
    logger.error(`Failed to apply plugin install to container for bot ${botId}`, { err });
    return c.json({ error: "Failed to apply plugin change to running container" }, 500);
  }

  // Emit activation meter events for billing audit trail
  if (meterEmitter && hostedKeyNames.length > 0) {
    for (const [capability, choice] of Object.entries(parsed.data.providerChoices)) {
      if (choice !== "hosted") continue;
      const capEntry = lookupCapabilityEnv(capability);
      if (!capEntry) continue;
      meterEmitter.emit({
        tenant: freshProfile.tenantId,
        cost: Credit.ZERO,
        charge: Credit.ZERO,
        capability: "hosted-activation",
        provider: capEntry.vaultProvider,
        timestamp: Date.now(),
      });
    }
  }

  logger.info(`Installed plugin ${id} on bot ${botId} via marketplace`, {
    botId,
    pluginId: id,
    tenantId: freshProfile.tenantId,
  });

  const staticPlugin = pluginRegistry.find((p) => p.id === id);
  return c.json({
    success: true,
    botId,
    pluginId: id,
    installedPlugins: [...existingPlugins, id],
    installedVersion: staticPlugin?.version ?? "unknown",
  });
});
