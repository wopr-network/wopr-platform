// src/api/routes/marketplace.ts
import { Hono } from "hono";
import type { AuditEnv } from "../../audit/types.js";
import { logger } from "../../config/logger.js";
import { pluginRegistry } from "./marketplace-registry.js";

export const marketplaceRoutes = new Hono<AuditEnv>();

/**
 * GET /api/marketplace/plugins
 *
 * List all available plugins in the marketplace.
 * Query params:
 *   - category: filter by plugin category
 *   - search: search by name/description/tags
 */
marketplaceRoutes.get("/plugins", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  let plugins = pluginRegistry;

  const category = c.req.query("category");
  if (category) {
    plugins = plugins.filter((p) => p.category === category);
  }

  const search = c.req.query("search")?.toLowerCase();
  if (search) {
    plugins = plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.description.toLowerCase().includes(search) ||
        p.tags.some((t) => t.includes(search)),
    );
  }

  return c.json(plugins);
});

/**
 * GET /api/marketplace/plugins/:id
 *
 * Get a single plugin manifest by ID.
 */
marketplaceRoutes.get("/plugins/:id", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const plugin = pluginRegistry.find((p) => p.id === id);
  if (!plugin) return c.json({ error: "Plugin not found" }, 404);

  return c.json(plugin);
});

/**
 * POST /api/marketplace/plugins/:id/install
 *
 * Trigger a plugin install. Records the intent and returns success.
 * Full install workflow is handled by WOP-682.
 */
marketplaceRoutes.post("/plugins/:id/install", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const plugin = pluginRegistry.find((p) => p.id === id);
  if (!plugin) return c.json({ error: "Plugin not found" }, 404);

  let config: Record<string, unknown> = {};
  try {
    config = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // No body is fine for a basic install trigger
  }

  logger.info("Plugin install requested", {
    pluginId: id,
    userId: user.id,
    config: Object.keys(config),
  });

  // TODO (WOP-682): Wire to fleet manager to actually configure
  // the plugin on the target bot instance.
  return c.json({ success: true });
});
