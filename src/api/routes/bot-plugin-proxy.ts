import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import type { IBotProfileRepository } from "../../fleet/bot-profile-repository.js";
import type { IPluginConfigRepository } from "../../setup/plugin-config-repository.js";
import { proxyToInstance } from "./friends-proxy.js";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;

const installBodySchema = z.object({
  pluginId: z.string().regex(PLUGIN_ID_RE),
});

const configBodySchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

export interface BotPluginProxyDeps {
  pluginConfigRepo: IPluginConfigRepository;
  profileRepo: IBotProfileRepository;
}

export function createBotPluginProxyRoutes(deps: BotPluginProxyDeps): Hono {
  const store = deps.profileRepo;
  const routes = new Hono();
  const tokenMetadataMap = buildTokenMetadataMap();
  const writeAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "write");

  // UUID validation middleware
  routes.use("/:botId/*", async (c, next) => {
    const botId = c.req.param("botId") as string;
    if (!UUID_RE.test(botId)) {
      return c.json({ error: "Invalid bot ID" }, 400);
    }
    return next();
  });

  /** POST /:botId/plugins/install — Install a plugin on a running daemon */
  routes.post("/:botId/plugins/install", writeAuth, async (c) => {
    const botId = c.req.param("botId") as string;

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

    const parsed = installBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { pluginId } = parsed.data;

    // Forward install to daemon
    const result = await proxyToInstance(botId, "POST", "/plugins/install", {
      source: pluginId,
    });

    if (!result.ok) {
      return c.json({ error: result.error ?? "Daemon install failed" }, result.status as ContentfulStatusCode);
    }

    // On success, also push stored config if present
    const storedConfig = await deps.pluginConfigRepo.findByBotAndPlugin(botId, pluginId);
    if (storedConfig) {
      try {
        const configData = JSON.parse(storedConfig.configJson) as unknown;
        await proxyToInstance(botId, "PUT", `/plugins/${pluginId}/config`, {
          config: configData,
        });
      } catch (err) {
        logger.warn(`Failed to push stored config for ${pluginId} on bot ${botId}`, { err });
        // Non-fatal — plugin is installed, config push failed
      }
    }

    return c.json(result.data ?? { success: true });
  });

  /** PUT /:botId/plugins/:pluginId/config — Update plugin config (save to DB + forward to daemon) */
  routes.put("/:botId/plugins/:pluginId/config", writeAuth, async (c) => {
    const botId = c.req.param("botId") as string;
    const pluginId = c.req.param("pluginId") as string;

    if (!PLUGIN_ID_RE.test(pluginId)) {
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

    const parsed = configBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    // Always save to DB first (source of truth)
    await deps.pluginConfigRepo.upsert({
      id: randomUUID(),
      botId,
      pluginId,
      configJson: JSON.stringify(parsed.data.config),
      encryptedFieldsJson: null,
      setupSessionId: null,
    });

    // Forward to daemon (best-effort — daemon may be offline)
    const result = await proxyToInstance(botId, "PUT", `/plugins/${pluginId}/config`, {
      config: parsed.data.config,
    });

    if (!result.ok) {
      // Config is saved; daemon just didn't get it yet
      return c.json({
        configSaved: true,
        daemonUpdated: false,
        daemonError: result.error,
      });
    }

    return c.json({
      configSaved: true,
      daemonUpdated: true,
      ...(result.data && typeof result.data === "object" ? result.data : {}),
    });
  });

  /** POST /:botId/plugins/:pluginId/enable — Enable a plugin on a running daemon */
  routes.post("/:botId/plugins/:pluginId/enable", writeAuth, async (c) => {
    const botId = c.req.param("botId") as string;
    const pluginId = c.req.param("pluginId") as string;

    if (!PLUGIN_ID_RE.test(pluginId)) {
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

    const result = await proxyToInstance(botId, "POST", `/plugins/${pluginId}/enable`);
    return c.json(
      result.ok ? (result.data ?? { success: true }) : { error: result.error },
      result.status as ContentfulStatusCode,
    );
  });

  /** POST /:botId/plugins/:pluginId/disable — Disable a plugin on a running daemon */
  routes.post("/:botId/plugins/:pluginId/disable", writeAuth, async (c) => {
    const botId = c.req.param("botId") as string;
    const pluginId = c.req.param("pluginId") as string;

    if (!PLUGIN_ID_RE.test(pluginId)) {
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

    const result = await proxyToInstance(botId, "POST", `/plugins/${pluginId}/disable`);
    return c.json(
      result.ok ? (result.data ?? { success: true }) : { error: result.error },
      result.status as ContentfulStatusCode,
    );
  });

  return routes;
}
