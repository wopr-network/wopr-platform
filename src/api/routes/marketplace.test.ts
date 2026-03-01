import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEnv } from "../../audit/types.js";
import { marketplaceRoutes, setMarketplaceDeps } from "./marketplace.js";
import type { PluginManifest } from "./marketplace-registry.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "test-user";

// Shared mock fleet state
let mockEnv: Record<string, string> = {};
let mockTenantId = OWNER_ID;

vi.mock("./fleet.js", () => ({
  fleet: {
    update: vi.fn(async (_botId: string, patch: { env?: Record<string, string> }) => {
      if (patch.env) mockEnv = patch.env;
    }),
  },
}));

vi.mock("../../fleet/profile-store.js", () => ({
  ProfileStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async (id: string) => {
      if (id === BOT_ID) return { tenantId: mockTenantId, env: { ...mockEnv } };
      return null;
    }),
  })),
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

describe("GET /api/marketplace/plugins", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/marketplace/plugins");
    expect(res.status).toBe(401);
  });

  it("returns full plugin list", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginManifest[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("category");
  });

  it("filters by category", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?category=voice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginManifest[];
    expect(body.length).toBeGreaterThan(0);
    for (const plugin of body) {
      expect(plugin.category).toBe("voice");
    }
  });

  it("returns empty array for category with no plugins", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?category=provider");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginManifest[];
    expect(body).toEqual([]);
  });

  it("filters by search query matching name", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?search=discord");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginManifest[];
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].id).toBe("discord-channel");
  });

  it("filters by search query matching tags", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins?search=analytics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginManifest[];
    expect(body.length).toBeGreaterThan(0);
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
});
