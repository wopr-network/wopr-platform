// src/api/routes/marketplace.ts
import { Hono } from "hono";
import { z } from "zod";
import type { AuditEnv } from "../../audit/types.js";
import { logger } from "../../config/logger.js";
import { getMarketplaceContentRepo, getMarketplacePluginRepo } from "../../fleet/services.js";
import { type PluginCategory, type PluginManifest, pluginRegistry } from "./marketplace-registry.js";

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
  } catch {
    // DB not available — fallback to static registry
    merged = [...pluginRegistry];
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
  } catch {
    // DB unavailable — only static lookup available
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
    } catch {
      /* DB unavailable */
    }
  }

  if (!plugin) return c.json({ error: "Plugin not found" }, 404);

  try {
    const contentRepo = getMarketplaceContentRepo();
    const cached = await contentRepo.getByPluginId(id);
    if (cached) {
      return c.json({ markdown: cached.markdown, source: cached.source, version: cached.version });
    }
  } catch {
    /* Content repo unavailable */
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
 * Validate a plugin install intent. Requires a botId in the request body.
 * Full server-side install orchestration is handled by WOP-682.
 * The UI calls POST /fleet/bots/:botId/plugins/:pluginId to complete the install.
 */
marketplaceRoutes.post("/plugins/:id/install", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const plugin = pluginRegistry.find((p) => p.id === id);
  if (!plugin) return c.json({ error: "Plugin not found" }, 404);

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

  logger.info("Plugin install requested", {
    pluginId: id,
    userId: user.id,
    botId: parsed.data.botId,
    config: Object.keys(parsed.data.config),
  });

  // BOUNDARY(WOP-682): Full server-side install orchestration pending.
  // The marketplace install validates the request and confirms the plugin exists.
  // The UI calls POST /fleet/bots/:botId/plugins/:pluginId to complete the install.
  return c.json({
    success: true,
    pluginId: id,
    botId: parsed.data.botId,
    message: "Install validated. Call POST /fleet/bots/:botId/plugins/:pluginId to complete.",
  });
});
