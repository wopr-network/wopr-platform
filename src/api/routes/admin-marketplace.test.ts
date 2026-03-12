import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type { IMarketplacePluginRepository } from "@wopr-network/platform-core/marketplace/marketplace-plugin-repository";
import type { MarketplacePlugin } from "@wopr-network/platform-core/marketplace/marketplace-repository-types";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAdminMarketplaceRoutes } from "./admin-marketplace.js";

function mockRepo(overrides: Partial<IMarketplacePluginRepository> = {}): IMarketplacePluginRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findEnabled: vi.fn().mockResolvedValue([]),
    findPendingReview: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue({} as never),
    update: vi.fn().mockResolvedValue({} as never),
    delete: vi.fn().mockResolvedValue(undefined),
    setInstallResult: vi.fn().mockResolvedValue(undefined),
    setVersion: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePlugin(overrides: Partial<MarketplacePlugin> = {}): MarketplacePlugin {
  return {
    pluginId: "test-plugin",
    npmPackage: "@wopr-network/wopr-plugin-test",
    version: "1.0.0",
    previousVersion: null,
    enabled: false,
    featured: false,
    sortOrder: 999,
    category: null,
    discoveredAt: Date.now(),
    enabledAt: null,
    enabledBy: null,
    notes: null,
    installedAt: null,
    installError: null,
    manifest: null,
    ...overrides,
  };
}

function buildApp(repo: IMarketplacePluginRepository): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Fake auth middleware — inject a user
  app.use("*", async (c, next) => {
    c.set("user", { id: "admin-1" } as never);
    await next();
  });
  app.route(
    "/",
    createAdminMarketplaceRoutes(() => repo),
  );
  return app;
}

describe("GET /plugins/:id/install-status", () => {
  it("returns 404 when plugin does not exist", async () => {
    const repo = mockRepo();
    const app = buildApp(repo);
    const res = await app.request("/plugins/nonexistent/install-status");
    expect(res.status).toBe(404);
  });

  it("returns pending when installedAt and installError are both null", async () => {
    const plugin = makePlugin({ installedAt: null, installError: null });
    const repo = mockRepo({ findById: vi.fn().mockResolvedValue(plugin) });
    const app = buildApp(repo);
    const res = await app.request("/plugins/test-plugin/install-status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      pluginId: "test-plugin",
      status: "pending",
      installedAt: null,
      installError: null,
    });
  });

  it("returns installed when installedAt is set", async () => {
    const ts = Date.now();
    const plugin = makePlugin({ installedAt: ts, installError: null });
    const repo = mockRepo({ findById: vi.fn().mockResolvedValue(plugin) });
    const app = buildApp(repo);
    const res = await app.request("/plugins/test-plugin/install-status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      pluginId: "test-plugin",
      status: "installed",
      installedAt: ts,
      installError: null,
    });
  });

  it("returns failed when installError is set", async () => {
    const plugin = makePlugin({ installedAt: null, installError: "npm ERR! 404" });
    const repo = mockRepo({ findById: vi.fn().mockResolvedValue(plugin) });
    const app = buildApp(repo);
    const res = await app.request("/plugins/test-plugin/install-status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      pluginId: "test-plugin",
      status: "failed",
      installedAt: null,
      installError: "npm ERR! 404",
    });
  });
});
