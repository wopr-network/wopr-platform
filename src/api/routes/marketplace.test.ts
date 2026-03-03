import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEnv } from "../../audit/types.js";
import { getMarketplaceContentRepo, getMarketplacePluginRepo } from "../../fleet/services.js";
import { FIRST_PARTY_PLUGINS } from "../../marketplace/first-party-plugins.js";
import type { MarketplacePlugin } from "../../marketplace/marketplace-repository-types.js";
import { marketplaceRoutes, setMarketplaceDeps } from "./marketplace.js";
import type { PluginManifest } from "./marketplace-registry.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "test-user";

// Shared mock fleet state
let mockEnv: Record<string, string> = {};
let mockTenantId = OWNER_ID;

// Convert first-party plugin manifests to DB-row shape for mock
function makeDbPlugin(manifest: PluginManifest): MarketplacePlugin {
  return {
    pluginId: manifest.id,
    npmPackage: `@wopr-network/wopr-plugin-${manifest.id}`,
    version: manifest.version,
    previousVersion: null,
    enabled: true,
    featured: false,
    sortOrder: 0,
    category: manifest.category,
    discoveredAt: 0,
    enabledAt: null,
    enabledBy: null,
    notes: null,
    installedAt: null,
    installError: null,
    manifest,
  };
}

const MOCK_DB_PLUGINS = FIRST_PARTY_PLUGINS.map(makeDbPlugin);

vi.mock("../../fleet/services.js", () => ({
  getMarketplacePluginRepo: vi.fn(() => ({
    findEnabled: vi.fn(async () => MOCK_DB_PLUGINS),
    findById: vi.fn(async (id: string) => MOCK_DB_PLUGINS.find((p) => p.pluginId === id)),
  })),
  getMarketplaceContentRepo: vi.fn(() => ({
    getByPluginId: vi.fn(async () => null),
  })),
}));

vi.mock("./fleet.js", () => ({
  fleet: {
    update: vi.fn(async (_botId: string, patch: { env?: Record<string, string> }) => {
      if (patch.env) mockEnv = patch.env;
    }),
  },
}));

vi.mock("../../fleet/profile-store.js", () => ({
  // biome-ignore lint/complexity/useArrowFunction: constructor mock requires function keyword
  ProfileStore: vi.fn().mockImplementation(function () {
    return {
      get: vi.fn(async (id: string) => {
        if (id === BOT_ID) return { tenantId: mockTenantId, env: { ...mockEnv } };
        return null;
      }),
    };
  }),
}));

// Build a test app with session user already injected
function makeApp(user: { id: string; roles: string[] } | null = { id: OWNER_ID, roles: ["user"] }) {
  const app = new Hono<AuditEnv>();
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
    }
    return next();
  });
  app.route("/api/marketplace", marketplaceRoutes);
  return app;
}

beforeEach(() => {
  mockEnv = {};
  mockTenantId = OWNER_ID;
  setMarketplaceDeps({ credentialVault: null, meterEmitter: null });
});

type PluginsPage = { plugins: PluginManifest[]; nextCursor: string | null; hasNextPage: boolean };

describe("GET /api/marketplace/plugins", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/marketplace/plugins");
    expect(res.status).toBe(401);
  });

  it("returns paginated plugin list with pagination envelope", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.plugins.length).toBeGreaterThan(0);
    expect(body.plugins[0]).toHaveProperty("id");
    expect(body.plugins[0]).toHaveProperty("name");
    expect(body.plugins[0]).toHaveProperty("category");
    expect(body).toHaveProperty("nextCursor");
    expect(body).toHaveProperty("hasNextPage");
  });

  it("filters by category", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?category=voice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.plugins.length).toBeGreaterThan(0);
    for (const plugin of body.plugins) {
      expect(plugin.category).toBe("voice");
    }
  });

  it("returns empty plugins array for category with no plugins", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?category=provider");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.plugins).toEqual([]);
    expect(body.hasNextPage).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("filters by search query matching name", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?search=discord");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.plugins.length).toBeGreaterThan(0);
    expect(body.plugins[0].id).toBe("discord-channel");
  });

  it("filters by search query matching tags", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?search=analytics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.plugins.length).toBeGreaterThan(0);
  });

  it("returns 503 when marketplace plugin repo throws", async () => {
    vi.mocked(getMarketplacePluginRepo).mockImplementationOnce(() => {
      throw new Error("DB connection failed");
    });

    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins");
    expect(res.status).toBe(503);
  });

  it("respects limit query param", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.plugins.length).toBe(1);
  });

  it("caps limit at 250", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?limit=9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.plugins.length).toBeLessThanOrEqual(250);
  });

  it("uses cursor to paginate to the next page", async () => {
    const app = makeApp();
    // Get first page with limit=1
    const res1 = await app.request("/api/marketplace/plugins?limit=1");
    expect(res1.status).toBe(200);
    const page1 = (await res1.json()) as PluginsPage;
    expect(page1.plugins.length).toBe(1);
    const firstId = page1.plugins[0].id;

    // Use cursor to get second page
    const res2 = await app.request(`/api/marketplace/plugins?limit=1&cursor=${firstId}`);
    expect(res2.status).toBe(200);
    const page2 = (await res2.json()) as PluginsPage;
    expect(page2.plugins.length).toBe(1);
    expect(page2.plugins[0].id).not.toBe(firstId);
  });

  it("returns hasNextPage=false and nextCursor=null on last page", async () => {
    const app = makeApp();
    // Fetch all plugins with a very large limit
    const res = await app.request("/api/marketplace/plugins?limit=250");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    expect(body.hasNextPage).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("returns hasNextPage=true and a nextCursor when more results remain", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsPage;
    // Only meaningful if there are at least 2 plugins in the registry
    if (body.hasNextPage) {
      expect(body.nextCursor).not.toBeNull();
    }
  });
});

describe("GET /api/marketplace/plugins/:id", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/marketplace/plugins/discord-channel");
    expect(res.status).toBe(401);
  });

  it("returns a single plugin by id", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginManifest;
    expect(body.id).toBe("discord-channel");
    expect(body.name).toBe("Discord");
  });

  it("returns 404 for unknown plugin id", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Plugin not found");
  });

  it("returns 503 when DB lookup throws for non-static plugin", async () => {
    vi.mocked(getMarketplacePluginRepo).mockImplementationOnce(
      () =>
        ({
          findEnabled: vi.fn(),
          findById: vi.fn(async () => {
            throw new Error("DB error");
          }),
        }) as unknown as ReturnType<typeof getMarketplacePluginRepo>,
    );

    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/some-dynamic-plugin");
    expect(res.status).toBe(503);
  });
});

describe("GET /api/marketplace/plugins/:id/content", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/marketplace/plugins/discord-channel/content");
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown plugin", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/nonexistent/content");
    expect(res.status).toBe(404);
  });

  it("returns manifest description as fallback when no cached content", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/content");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string; source: string };
    expect(body.source).toBe("manifest_description");
    expect(body.markdown).toBeTruthy();
  });

  it("returns 503 when plugin repo throws for non-static plugin in content endpoint", async () => {
    vi.mocked(getMarketplacePluginRepo).mockImplementationOnce(
      () =>
        ({
          findEnabled: vi.fn(),
          findById: vi.fn(async () => {
            throw new Error("DB error");
          }),
        }) as unknown as ReturnType<typeof getMarketplacePluginRepo>,
    );

    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/some-dynamic-plugin/content");
    expect(res.status).toBe(503);
  });

  it("returns 503 when content repo throws", async () => {
    vi.mocked(getMarketplaceContentRepo).mockImplementationOnce(
      () =>
        ({
          getByPluginId: vi.fn(async () => {
            throw new Error("Content DB error");
          }),
        }) as unknown as ReturnType<typeof getMarketplaceContentRepo>,
    );

    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/content");
    expect(res.status).toBe(503);
  });
});
describe("POST /api/marketplace/plugins/:id/install", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns success with valid botId", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      pluginId: string;
      botId: string;
      installedPlugins: string[];
      installedVersion: string;
    };
    expect(body.success).toBe(true);
    expect(body.pluginId).toBe("discord-channel");
    expect(body.botId).toBe(BOT_ID);
    expect(body.installedPlugins).toContain("discord-channel");
    expect(typeof body.installedVersion).toBe("string");
  });

  it("returns 403 when user does not own the bot", async () => {
    const app = makeApp({ id: "different-user", roles: ["user"] });
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when bot does not exist", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "00000000-0000-4000-8000-000000000099" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when plugin is already installed", async () => {
    mockEnv = { WOPR_PLUGINS: "discord-channel" };
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already installed/);
  });

  it("returns 400 with empty body (botId required)", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/slack-channel/install", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when botId is missing from body", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/botId/);
  });

  it("returns 400 when botId is not a valid UUID", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/botId/);
  });

  it("returns 404 for unknown plugin id", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/does-not-exist/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Plugin not found");
  });

  it("returns 503 when DB lookup throws during plugin existence check on install", async () => {
    vi.mocked(getMarketplacePluginRepo).mockImplementationOnce(
      () =>
        ({
          findEnabled: vi.fn(),
          findById: vi.fn(async () => {
            throw new Error("DB error");
          }),
        }) as unknown as ReturnType<typeof getMarketplacePluginRepo>,
    );

    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/some-dynamic-plugin/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: BOT_ID }),
    });
    expect(res.status).toBe(503);
  });
});
