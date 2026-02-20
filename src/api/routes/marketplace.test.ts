import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuditEnv } from "../../audit/types.js";
import { marketplaceRoutes } from "./marketplace.js";
import type { PluginManifest } from "./marketplace-registry.js";

// Build a test app with session user already injected
function makeApp(user: { id: string; roles: string[] } | null = { id: "test-user", roles: ["user"] }) {
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

describe("POST /api/marketplace/plugins/:id/install", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns success for a known plugin", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/discord-channel/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "abc123", guildId: "123456789" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns success with empty body", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/slack-channel/install", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns 404 for unknown plugin id", async () => {
    const app = makeApp();
    const res = await app.request("/api/marketplace/plugins/does-not-exist/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Plugin not found");
  });
});
