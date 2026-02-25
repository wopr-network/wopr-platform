import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminMarketplaceRoutes } from "../../src/api/routes/admin-marketplace.js";
import type { IMarketplacePluginRepository } from "../../src/marketplace/marketplace-plugin-repository.js";
import type { MarketplacePlugin, NewMarketplacePlugin } from "../../src/marketplace/marketplace-repository-types.js";

function makeMockRepo(): IMarketplacePluginRepository {
  const store = new Map<string, MarketplacePlugin>();
  return {
    findAll: () => [...store.values()],
    findEnabled: () => [...store.values()].filter((p) => p.enabled),
    findPendingReview: () => [...store.values()].filter((p) => !p.enabled),
    findById: (id: string) => store.get(id),
    insert: (p: NewMarketplacePlugin) => {
      const plugin: MarketplacePlugin = {
        pluginId: p.pluginId,
        npmPackage: p.npmPackage,
        version: p.version,
        enabled: false,
        featured: false,
        sortOrder: 999,
        category: p.category ?? null,
        discoveredAt: Date.now(),
        enabledAt: null,
        enabledBy: null,
        notes: p.notes ?? null,
      };
      store.set(p.pluginId, plugin);
      return plugin;
    },
    update: (id: string, patch: Partial<MarketplacePlugin>) => {
      const existing = store.get(id)!;
      const updated = { ...existing, ...patch };
      store.set(id, updated);
      return updated;
    },
    delete: (id: string) => {
      store.delete(id);
    },
  };
}

describe("admin marketplace routes", () => {
  let app: Hono;
  let repo: IMarketplacePluginRepository;

  beforeEach(() => {
    repo = makeMockRepo();
    const routes = createAdminMarketplaceRoutes(() => repo);
    app = new Hono();
    // Simulate admin auth middleware setting user
    app.use("*", async (c, next) => {
      c.set("user", { id: "admin-1", role: "platform_admin" });
      await next();
    });
    app.route("/", routes);
  });

  it("GET /plugins returns all plugins", async () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const res = await app.request("/plugins");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it("POST /plugins manually adds a plugin", async () => {
    const res = await app.request("/plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ npmPackage: "@wopr-network/wopr-plugin-test", version: "1.0.0" }),
    });
    expect(res.status).toBe(201);
    expect(repo.findAll()).toHaveLength(1);
  });

  it("PATCH /plugins/:id updates a plugin", async () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const res = await app.request("/plugins/a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, sortOrder: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it("DELETE /plugins/:id removes a plugin", async () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const res = await app.request("/plugins/a", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(repo.findAll()).toHaveLength(0);
  });

  it("GET /queue returns pending review plugins", async () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const res = await app.request("/queue");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it("PATCH /plugins/:id returns 404 for unknown plugin", async () => {
    const res = await app.request("/plugins/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });
});
