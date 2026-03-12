import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type { IMarketplacePluginRepository } from "@wopr-network/platform-core/marketplace/marketplace-plugin-repository";
import { Hono } from "hono";
import { z } from "zod";
import { getAdminAuditLog } from "../../platform-services.js";

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
  routes.get("/plugins", async (c) => {
    return c.json(await repo().findAll());
  });

  // GET /queue — list plugins pending review (enabled = false)
  routes.get("/queue", async (c) => {
    return c.json(await repo().findPendingReview());
  });

  // POST /plugins — manually add a plugin by npm package name
  routes.post("/plugins", async (c) => {
    const body = await c.req.json();
    const parsed = addPluginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { npmPackage, version, category, notes } = parsed.data;
    const existing = await repo().findById(npmPackage);
    if (existing) {
      return c.json({ error: "Plugin already exists" }, 409);
    }

    const plugin = await repo().insert({
      pluginId: npmPackage,
      npmPackage,
      version,
      category,
      notes,
    });
    try {
      const user = c.get("user") as { id: string } | undefined;
      getAdminAuditLog().log({
        adminUser: user?.id ?? "unknown",
        action: "marketplace.plugin.create",
        category: "config",
        details: { pluginId: npmPackage, version },
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }

    // Fire-and-forget: install into shared volume
    const volumePath = process.env.PLUGIN_VOLUME_PATH ?? "/data/plugins";
    import("@wopr-network/platform-core/marketplace/volume-installer")
      .then(({ installPluginToVolume }) => {
        installPluginToVolume({
          pluginId: npmPackage,
          npmPackage,
          version,
          volumePath,
          repo: repo(),
        }).catch((err: unknown) => {
          import("@wopr-network/platform-core/config/logger")
            .then(({ logger }) => {
              logger.error("Volume install trigger failed", { pluginId: npmPackage, err });
            })
            .catch(() => {
              /* logger unavailable */
            });
        });
      })
      .catch(() => {
        /* volume installer unavailable — non-fatal */
      });

    return c.json(plugin, 201);
  });

  // PATCH /plugins/:id — update plugin (enable/disable, feature, sort, notes)
  routes.patch("/plugins/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await repo().findById(id);
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

    const updated = await repo().update(
      id,
      patch as Partial<
        import("@wopr-network/platform-core/marketplace/marketplace-repository-types").MarketplacePlugin
      >,
    );
    try {
      const user = c.get("user") as { id: string } | undefined;
      getAdminAuditLog().log({
        adminUser: user?.id ?? "unknown",
        action: "marketplace.plugin.update",
        category: "config",
        details: { pluginId: id, patch },
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }
    return c.json(updated);
  });

  // DELETE /plugins/:id — remove a plugin from the registry
  routes.delete("/plugins/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await repo().findById(id);
    if (!existing) {
      return c.json({ error: "Plugin not found" }, 404);
    }
    await repo().delete(id);
    try {
      const user = c.get("user") as { id: string } | undefined;
      getAdminAuditLog().log({
        adminUser: user?.id ?? "unknown",
        action: "marketplace.plugin.delete",
        category: "config",
        details: { pluginId: id },
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }
    return c.body(null, 204);
  });

  // GET /plugins/:id/install-status — poll install progress
  routes.get("/plugins/:id/install-status", async (c) => {
    const id = c.req.param("id");
    const plugin = await repo().findById(id);
    if (!plugin) {
      return c.json({ error: "Plugin not found" }, 404);
    }

    const status = plugin.installedAt ? "installed" : plugin.installError ? "failed" : "pending";

    return c.json({
      pluginId: plugin.pluginId,
      status,
      installedAt: plugin.installedAt,
      installError: plugin.installError,
    });
  });

  // POST /discover — trigger manual discovery run
  routes.post("/discover", async (c) => {
    const { discoverNpmPlugins } = await import("@wopr-network/platform-core/marketplace/npm-discovery");
    const { logger } = await import("@wopr-network/platform-core/config/logger");
    const result = await discoverNpmPlugins({
      repo: repo(),
      notify: (msg: string) => {
        logger.info(`[Marketplace] ${msg}`);
      },
    });
    try {
      const user = c.get("user") as { id: string } | undefined;
      getAdminAuditLog().log({
        adminUser: user?.id ?? "unknown",
        action: "marketplace.discovery.trigger",
        category: "config",
        details: { discovered: result.discovered, skipped: result.skipped },
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }
    return c.json(result);
  });

  return routes;
}
