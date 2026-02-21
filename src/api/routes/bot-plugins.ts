import { Hono } from "hono";
import { z } from "zod";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { ProfileStore } from "../../fleet/profile-store.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const store = new ProfileStore(DATA_DIR);

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

  // Merge plugin config into env as WOPR_PLUGIN_<UPPER_SNAKE>_CONFIG=<json>
  const configEnvKey = `WOPR_PLUGIN_${pluginId.toUpperCase().replace(/-/g, "_")}_CONFIG`;
  const updatedEnv = {
    ...freshProfile.env,
    WOPR_PLUGINS: updatedPlugins,
    [configEnvKey]: JSON.stringify(parsed.data.config),
  };

  // Save updated profile (env change triggers container recreation via fleet update)
  const updated = { ...freshProfile, env: updatedEnv };
  await store.save(updated);

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

/** PATCH /fleet/bots/:botId/plugins/:pluginId — Toggle plugin enabled state */
botPluginRoutes.patch("/bots/:botId/plugins/:pluginId", writeAuth, async (c) => {
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

  logger.info(`Toggled plugin ${pluginId} on bot ${botId}: enabled=${parsed.data.enabled}`, {
    botId,
    pluginId,
    enabled: parsed.data.enabled,
    tenantId: profile.tenantId,
  });

  return c.json({
    success: true,
    botId,
    pluginId,
    enabled: parsed.data.enabled,
  });
});
