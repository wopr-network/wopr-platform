import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { botInstances } from "../../db/schema/index.js";
import { lookupCapabilityEnv } from "../../fleet/capability-env-map.js";
import { BotNotFoundError } from "../../fleet/fleet-manager.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { getCommandBus, getDb } from "../../fleet/services.js";
import type { MeterEvent } from "../../monetization/metering/types.js";
import type { DecryptedCredential } from "../../security/credential-vault/store.js";
import { fleet } from "./fleet.js";
import { pluginRegistry } from "./marketplace-registry.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const store = new ProfileStore(DATA_DIR);

// Dependencies injected for hosted credential resolution.
// In production these are set by the app bootstrap; tests mock them.
let credentialVault: {
  getActiveForProvider(provider: string): Promise<Array<Pick<DecryptedCredential, "plaintextKey">>>;
} | null = null;
let meterEmitter: { emit(event: MeterEvent): void } | null = null;

export function setBotPluginDeps(deps: {
  credentialVault: typeof credentialVault;
  meterEmitter: typeof meterEmitter;
}): void {
  credentialVault = deps.credentialVault;
  meterEmitter = deps.meterEmitter;
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const botPluginRoutes = new Hono();

const tokenMetadataMap = buildTokenMetadataMap();
const readAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "read");
const writeAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "write");

// UUID validation middleware for :botId param
botPluginRoutes.use("/bots/:botId/*", async (c, next) => {
  const botId = c.req.param("botId");
  if (!UUID_RE.test(botId)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }
  return next();
});

// Zod schema for install request body
const installPluginSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  providerChoices: z.record(z.string(), z.enum(["byok", "hosted"])).default({}),
});

/**
 * Dispatch a bot.update command to the node running this bot.
 * Returns { dispatched: true } on success, { dispatched: false, dispatchError } on failure.
 * Never throws -- dispatch failure is non-fatal (DB is source of truth).
 */
async function dispatchEnvUpdate(
  botId: string,
  tenantId: string,
  env: Record<string, string>,
): Promise<{ dispatched: boolean; dispatchError?: string }> {
  try {
    const db = getDb();
    const instance = (await db.select().from(botInstances).where(eq(botInstances.id, botId)))[0];

    if (!instance?.nodeId) {
      return { dispatched: false, dispatchError: "bot_not_deployed" };
    }

    await getCommandBus().send(instance.nodeId, {
      type: "bot.update",
      payload: {
        name: `tenant_${tenantId}`,
        env,
      },
    });

    return { dispatched: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to dispatch bot.update for ${botId}: ${message}`);
    return { dispatched: false, dispatchError: message };
  }
}

/** POST /fleet/bots/:botId/plugins/:pluginId — Install a plugin on a bot */
botPluginRoutes.post("/bots/:botId/plugins/:pluginId", writeAuth, async (c) => {
  const botId = c.req.param("botId");
  const pluginId = c.req.param("pluginId");

  // Validate pluginId format (alphanumeric + hyphens, 1-64 chars)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(pluginId)) {
    return c.json({ error: "Invalid plugin ID format" }, 400);
  }

  // Get bot profile and validate tenant ownership
  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = installPluginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Re-fetch profile immediately before write to avoid clobbering concurrent installs
  const freshProfile = await store.get(botId);
  if (!freshProfile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  // Re-validate ownership on the fresh profile — tenantId may have changed between fetches
  const freshOwnershipError = validateTenantOwnership(c, freshProfile, freshProfile.tenantId);
  if (freshOwnershipError) {
    return freshOwnershipError;
  }

  // Read existing WOPR_PLUGINS env var (comma-separated plugin IDs)
  const existingPlugins = (freshProfile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (existingPlugins.includes(pluginId)) {
    return c.json({ error: "Plugin already installed", pluginId }, 409);
  }

  // Add pluginId to WOPR_PLUGINS list
  const updatedPlugins = [...existingPlugins, pluginId].join(",");

  // --- Resolve hosted provider choices BEFORE writing to profile ---
  const hostedEnvVars: Record<string, string> = {};
  const hostedKeyNames: string[] = [];

  for (const [capability, choice] of Object.entries(parsed.data.providerChoices)) {
    if (choice !== "hosted") continue; // byok = no-op

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

  // Re-read WOPR_HOSTED_KEYS from freshProfile immediately before write to avoid clobbering
  // hosted key tracking from concurrent plugin installs (same pattern used for WOPR_PLUGINS above).
  const existingHostedKeys = (freshProfile.env.WOPR_HOSTED_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allHostedKeys = [...new Set([...existingHostedKeys, ...hostedKeyNames])];

  // Merge plugin config into env as WOPR_PLUGIN_<UPPER_SNAKE>_CONFIG=<json>
  // Store both config and providerChoices so DELETE can selectively clean up hosted keys.
  const configEnvKey = `WOPR_PLUGIN_${pluginId.toUpperCase().replace(/-/g, "_")}_CONFIG`;
  const updatedEnv: Record<string, string> = {
    ...freshProfile.env,
    WOPR_PLUGINS: updatedPlugins,
    [configEnvKey]: JSON.stringify({ config: parsed.data.config, providerChoices: parsed.data.providerChoices }),
    ...hostedEnvVars,
  };

  // Only set WOPR_HOSTED_KEYS if there are hosted keys
  if (allHostedKeys.length > 0) {
    updatedEnv.WOPR_HOSTED_KEYS = allHostedKeys.join(",");
  }

  // Apply env change to profile and running container
  try {
    await fleet.update(botId, { env: updatedEnv });
  } catch (err) {
    if (err instanceof BotNotFoundError) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }
    // fleet.update() rolls back the profile internally on container failure,
    // so the profile is reverted to freshProfile's state.
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
        tenant: profile.tenantId,
        cost: 0,
        charge: 0,
        capability: "hosted-activation",
        provider: capEntry.vaultProvider,
        timestamp: Date.now(),
      });
    }
  }

  logger.info(`Installed plugin ${pluginId} on bot ${botId}`, {
    botId,
    pluginId,
    tenantId: profile.tenantId,
  });

  return c.json(
    {
      success: true,
      botId,
      pluginId,
      installedPlugins: [...existingPlugins, pluginId],
    },
    200,
  );
});

/** GET /fleet/bots/:botId/plugins — List installed plugins on a bot */
botPluginRoutes.get("/bots/:botId/plugins", readAuth, async (c) => {
  const botId = c.req.param("botId");

  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
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

  const plugins = pluginIds.map((id) => ({
    pluginId: id,
    enabled: !disabledSet.has(id),
  }));

  return c.json({ botId, plugins });
});

/** Shared toggle handler for PATCH and PUT /fleet/bots/:botId/plugins/:pluginId */
async function togglePluginHandler(c: Context): Promise<Response> {
  const botId = c.req.param("botId");
  const pluginId = c.req.param("pluginId");

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(pluginId)) {
    return c.json({ error: "Invalid plugin ID format" }, 400);
  }

  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const installedPlugins = (profile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!installedPlugins.includes(pluginId)) {
    return c.json({ error: "Plugin not installed", pluginId }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const disabledPlugins = (profile.env.WOPR_PLUGINS_DISABLED || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let updatedDisabled: string[];
  if (parsed.data.enabled) {
    updatedDisabled = disabledPlugins.filter((id) => id !== pluginId);
  } else {
    updatedDisabled = disabledPlugins.includes(pluginId) ? disabledPlugins : [...disabledPlugins, pluginId];
  }

  const { WOPR_PLUGINS_DISABLED: _removed, ...envWithoutDisabled } = profile.env;
  const updatedEnv = updatedDisabled.length
    ? { ...envWithoutDisabled, WOPR_PLUGINS_DISABLED: updatedDisabled.join(",") }
    : envWithoutDisabled;

  const updated = { ...profile, env: updatedEnv };
  await store.save(updated);

  // Dispatch env update to the correct node
  const dispatch = await dispatchEnvUpdate(botId, profile.tenantId, updatedEnv);

  logger.info(`Toggled plugin ${pluginId} on bot ${botId}: enabled=${parsed.data.enabled}`, {
    botId,
    pluginId,
    enabled: parsed.data.enabled,
    tenantId: profile.tenantId,
    dispatched: dispatch.dispatched,
  });

  return c.json({
    success: true,
    botId,
    pluginId,
    enabled: parsed.data.enabled,
    dispatched: dispatch.dispatched,
    ...(dispatch.dispatchError ? { dispatchError: dispatch.dispatchError } : {}),
  });
}

/** PATCH /fleet/bots/:botId/plugins/:pluginId — Toggle plugin enabled state */
botPluginRoutes.patch("/bots/:botId/plugins/:pluginId", writeAuth, togglePluginHandler);

/** PUT /fleet/bots/:botId/plugins/:pluginId — Toggle plugin enabled state (alias for PATCH) */
botPluginRoutes.put("/bots/:botId/plugins/:pluginId", writeAuth, togglePluginHandler);

/** DELETE /fleet/bots/:botId/plugins/:pluginId — Uninstall a plugin from a bot */
botPluginRoutes.delete("/bots/:botId/plugins/:pluginId", writeAuth, async (c) => {
  const botId = c.req.param("botId");
  const pluginId = c.req.param("pluginId");

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(pluginId)) {
    return c.json({ error: "Invalid plugin ID format" }, 400);
  }

  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const installedPlugins = (profile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!installedPlugins.includes(pluginId)) {
    return c.json({ error: "Plugin not installed", pluginId }, 404);
  }

  // Remove plugin from WOPR_PLUGINS list
  const remainingPlugins = installedPlugins.filter((id) => id !== pluginId);

  // Read the plugin config env var BEFORE removing it to extract providerChoices,
  // which tells us which hosted keys this specific plugin installed.
  const configEnvKey = `WOPR_PLUGIN_${pluginId.toUpperCase().replace(/-/g, "_")}_CONFIG`;
  const pluginConfigRaw = profile.env[configEnvKey];
  const deletedPluginHostedKeyNames: string[] = [];
  if (pluginConfigRaw) {
    try {
      const pluginConfigData = JSON.parse(pluginConfigRaw) as { providerChoices?: Record<string, string> };
      if (pluginConfigData.providerChoices) {
        for (const [capability, choice] of Object.entries(pluginConfigData.providerChoices)) {
          if (choice === "hosted") {
            const capEntry = lookupCapabilityEnv(capability);
            if (capEntry) {
              deletedPluginHostedKeyNames.push(capEntry.envKey);
            }
          }
        }
      }
    } catch {
      // Malformed config — can't determine which keys to remove; leave them
    }
  }

  const { [configEnvKey]: _removedConfig, ...envWithoutConfig } = profile.env;

  // Determine which hosted keys should be removed: only those contributed by the deleted plugin.
  // We must not remove keys that other remaining plugins may still need.
  // Strategy: remove keys contributed by the deleted plugin from the env AND from WOPR_HOSTED_KEYS.
  const currentHostedKeys = (envWithoutConfig.WOPR_HOSTED_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const deletedKeySet = new Set(deletedPluginHostedKeyNames);
  const remainingHostedKeys = currentHostedKeys.filter((k) => !deletedKeySet.has(k));

  const updatedEnv: Record<string, string> = { ...envWithoutConfig };

  // Remove the specific env vars that belonged to the deleted plugin
  for (const key of deletedPluginHostedKeyNames) {
    delete updatedEnv[key];
  }

  // Update or remove WOPR_HOSTED_KEYS tracking list
  if (remainingHostedKeys.length > 0) {
    updatedEnv.WOPR_HOSTED_KEYS = remainingHostedKeys.join(",");
  } else {
    delete updatedEnv.WOPR_HOSTED_KEYS;
  }

  // Update or remove WOPR_PLUGINS
  if (remainingPlugins.length === 0) {
    delete updatedEnv.WOPR_PLUGINS;
  } else {
    updatedEnv.WOPR_PLUGINS = remainingPlugins.join(",");
  }

  // Clean up WOPR_PLUGINS_DISABLED for this plugin
  const disabledPlugins = (updatedEnv.WOPR_PLUGINS_DISABLED || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((id) => id !== pluginId);

  if (disabledPlugins.length > 0) {
    updatedEnv.WOPR_PLUGINS_DISABLED = disabledPlugins.join(",");
  } else {
    delete updatedEnv.WOPR_PLUGINS_DISABLED;
  }

  let applied = false;
  try {
    await fleet.update(botId, { env: updatedEnv });
    applied = true;
  } catch (err) {
    if (err instanceof BotNotFoundError) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }
    logger.error(`Failed to apply plugin uninstall to container for bot ${botId}`, { err });
    return c.json({ error: "Failed to apply plugin change to running container" }, 500);
  }

  logger.info(`Uninstalled plugin ${pluginId} from bot ${botId}`, {
    botId,
    pluginId,
    tenantId: profile.tenantId,
  });

  return c.json({
    success: true,
    botId,
    pluginId,
    installedPlugins: remainingPlugins,
    applied,
  });
});

// ---------------------------------------------------------------------------
// Channel management routes — filtered view of plugins with category "channel"
// ---------------------------------------------------------------------------

/** Helper: check if a pluginId is a channel-category plugin in the registry. */
function isChannelPlugin(pluginId: string): boolean {
  const entry = pluginRegistry.find((p) => p.id === pluginId);
  return entry?.category === "channel";
}

/** GET /fleet/bots/:botId/channels — List connected channels (channel-category plugins) */
botPluginRoutes.get("/bots/:botId/channels", readAuth, async (c) => {
  const botId = c.req.param("botId");

  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
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

  // Filter to only channel-category plugins
  const channels = pluginIds
    .filter((id) => isChannelPlugin(id))
    .map((id) => ({
      pluginId: id,
      enabled: !disabledSet.has(id),
    }));

  return c.json({ botId, channels });
});

/** POST /fleet/bots/:botId/channels/:pluginId — Connect a channel (install channel plugin) */
botPluginRoutes.post("/bots/:botId/channels/:pluginId", writeAuth, async (c) => {
  const pluginId = c.req.param("pluginId");

  if (!isChannelPlugin(pluginId)) {
    return c.json({ error: `Plugin "${pluginId}" is not a channel plugin` }, 400);
  }

  // Delegate to the shared install endpoint by forwarding to the same handler logic.
  // The botId UUID middleware and ownership validation are handled below.
  const botId = c.req.param("botId");

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(pluginId)) {
    return c.json({ error: "Invalid plugin ID format" }, 400);
  }

  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = installPluginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Re-fetch profile immediately before write to avoid clobbering concurrent installs
  const freshProfile = await store.get(botId);
  if (!freshProfile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const freshOwnershipError = validateTenantOwnership(c, freshProfile, freshProfile.tenantId);
  if (freshOwnershipError) {
    return freshOwnershipError;
  }

  const existingPlugins = (freshProfile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (existingPlugins.includes(pluginId)) {
    return c.json({ error: "Plugin already installed", pluginId }, 409);
  }

  const updatedPlugins = [...existingPlugins, pluginId].join(",");

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

  const configEnvKey = `WOPR_PLUGIN_${pluginId.toUpperCase().replace(/-/g, "_")}_CONFIG`;
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
    logger.error(`Failed to apply channel connect to container for bot ${botId}`, { err });
    return c.json({ error: "Failed to apply plugin change to running container" }, 500);
  }

  if (meterEmitter && hostedKeyNames.length > 0) {
    for (const [capability, choice] of Object.entries(parsed.data.providerChoices)) {
      if (choice !== "hosted") continue;
      const capEntry = lookupCapabilityEnv(capability);
      if (!capEntry) continue;
      meterEmitter.emit({
        tenant: profile.tenantId,
        cost: 0,
        charge: 0,
        capability: "hosted-activation",
        provider: capEntry.vaultProvider,
        timestamp: Date.now(),
      });
    }
  }

  logger.info(`Connected channel ${pluginId} on bot ${botId}`, { botId, pluginId, tenantId: profile.tenantId });

  return c.json(
    {
      success: true,
      botId,
      pluginId,
      installedPlugins: [...existingPlugins, pluginId],
    },
    200,
  );
});

/** DELETE /fleet/bots/:botId/channels/:pluginId — Disconnect a channel (uninstall channel plugin) */
botPluginRoutes.delete("/bots/:botId/channels/:pluginId", writeAuth, async (c) => {
  const botId = c.req.param("botId");
  const pluginId = c.req.param("pluginId");

  if (!isChannelPlugin(pluginId)) {
    return c.json({ error: `Plugin "${pluginId}" is not a channel plugin` }, 400);
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(pluginId)) {
    return c.json({ error: "Invalid plugin ID format" }, 400);
  }

  const profile = await store.get(botId);
  if (!profile) {
    return c.json({ error: `Bot not found: ${botId}` }, 404);
  }

  const ownershipError = validateTenantOwnership(c, profile, profile.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const installedPlugins = (profile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!installedPlugins.includes(pluginId)) {
    return c.json({ error: "Plugin not installed", pluginId }, 404);
  }

  const remainingPlugins = installedPlugins.filter((id) => id !== pluginId);

  const configEnvKey = `WOPR_PLUGIN_${pluginId.toUpperCase().replace(/-/g, "_")}_CONFIG`;
  const pluginConfigRaw = profile.env[configEnvKey];
  const deletedPluginHostedKeyNames: string[] = [];
  if (pluginConfigRaw) {
    try {
      const pluginConfigData = JSON.parse(pluginConfigRaw) as { providerChoices?: Record<string, string> };
      if (pluginConfigData.providerChoices) {
        for (const [capability, choice] of Object.entries(pluginConfigData.providerChoices)) {
          if (choice === "hosted") {
            const capEntry = lookupCapabilityEnv(capability);
            if (capEntry) {
              deletedPluginHostedKeyNames.push(capEntry.envKey);
            }
          }
        }
      }
    } catch {
      // Malformed config — can't determine which keys to remove; leave them
    }
  }

  const { [configEnvKey]: _removedConfig, ...envWithoutConfig } = profile.env;

  const currentHostedKeys = (envWithoutConfig.WOPR_HOSTED_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const deletedKeySet = new Set(deletedPluginHostedKeyNames);
  const remainingHostedKeys = currentHostedKeys.filter((k) => !deletedKeySet.has(k));

  const updatedEnv: Record<string, string> = { ...envWithoutConfig };

  for (const key of deletedPluginHostedKeyNames) {
    delete updatedEnv[key];
  }

  if (remainingHostedKeys.length > 0) {
    updatedEnv.WOPR_HOSTED_KEYS = remainingHostedKeys.join(",");
  } else {
    delete updatedEnv.WOPR_HOSTED_KEYS;
  }

  if (remainingPlugins.length === 0) {
    delete updatedEnv.WOPR_PLUGINS;
  } else {
    updatedEnv.WOPR_PLUGINS = remainingPlugins.join(",");
  }

  const disabledPlugins = (updatedEnv.WOPR_PLUGINS_DISABLED || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((id) => id !== pluginId);

  if (disabledPlugins.length > 0) {
    updatedEnv.WOPR_PLUGINS_DISABLED = disabledPlugins.join(",");
  } else {
    delete updatedEnv.WOPR_PLUGINS_DISABLED;
  }

  let applied = false;
  try {
    await fleet.update(botId, { env: updatedEnv });
    applied = true;
  } catch (err) {
    if (err instanceof BotNotFoundError) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }
    logger.error(`Failed to apply channel disconnect from container for bot ${botId}`, { err });
    return c.json({ error: "Failed to apply plugin change to running container" }, 500);
  }

  logger.info(`Disconnected channel ${pluginId} from bot ${botId}`, { botId, pluginId, tenantId: profile.tenantId });

  return c.json({
    success: true,
    botId,
    pluginId,
    installedPlugins: remainingPlugins,
    applied,
  });
});
