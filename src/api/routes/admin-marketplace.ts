import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import type { IMarketplacePluginRepository } from "../../marketplace/marketplace-plugin-repository.js";

const addPluginSchema = z.object({
  npmPackage: z.string().min(1),
  version: z.string().min(1),
  category: z.string().optional(),
  notes: z.string().optional(),
});

const updatePluginSchema = z.object({
  enabled: z.boolean().optional(),
  featured: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export function createAdminMarketplaceRoutes(repoFactory: () => IMarketplacePluginRepository): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  let _repo: IMarketplacePluginRepository | null = null;
  const repo = (): IMarketplacePluginRepository => {
    if (!_repo) _repo = repoFactory();
    return _repo;
  };

  // GET /plugins — list all marketplace plugins
  routes.get("/plugins", (c) => {
    return c.json(repo().findAll());
  });

  // GET /queue — list plugins pending review (enabled = false)
  routes.get("/queue", (c) => {
    return c.json(repo().findPendingReview());
  });

  // POST /plugins — manually add a plugin by npm package name
  routes.post("/plugins", async (c) => {
    const body = await c.req.json();
    const parsed = addPluginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { npmPackage, version, category, notes } = parsed.data;
    const existing = repo().findById(npmPackage);
    if (existing) {
      return c.json({ error: "Plugin already exists" }, 409);
    }

    const plugin = repo().insert({
      pluginId: npmPackage,
      npmPackage,
      version,
      category,
      notes,
    });
    return c.json(plugin, 201);
  });

  // PATCH /plugins/:id — update plugin (enable/disable, feature, sort, notes)
  routes.patch("/plugins/:id", async (c) => {
    const id = c.req.param("id");
    const existing = repo().findById(id);
    if (!existing) {
      return c.json({ error: "Plugin not found" }, 404);
    }

    const body = await c.req.json();
    const parsed = updatePluginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const patch: Record<string, unknown> = { ...parsed.data };
    // When enabling, record who did it
    if (parsed.data.enabled === true) {
      const user = c.get("user") as { id: string } | undefined;
      if (user) patch.enabledBy = user.id;
    }

    const updated = repo().update(
      id,
      patch as Partial<import("../../marketplace/marketplace-repository-types.js").MarketplacePlugin>,
    );
    return c.json(updated);
  });

  // DELETE /plugins/:id — remove a plugin from the registry
  routes.delete("/plugins/:id", (c) => {
    const id = c.req.param("id");
    const existing = repo().findById(id);
    if (!existing) {
      return c.json({ error: "Plugin not found" }, 404);
    }
    repo().delete(id);
    return c.body(null, 204);
  });

  // POST /discover — trigger manual discovery run
  routes.post("/discover", async (c) => {
    const { discoverNpmPlugins } = await import("../../marketplace/npm-discovery.js");
    const { logger } = await import("../../config/logger.js");
    const result = await discoverNpmPlugins({
      repo: repo(),
      notify: (msg: string) => {
        logger.info(`[Marketplace] ${msg}`);
      },
    });
    return c.json(result);
  });

  return routes;
}
