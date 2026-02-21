import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, AuthUser } from "../../auth/index.js";
import { channelTestRoutes } from "./channel-test.js";

function createTestApp(user?: AuthUser) {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
      c.set("authMethod", "session");
    }
    return next();
  });
  app.route("/", channelTestRoutes);
  return app;
}

const authedApp = () => createTestApp({ id: "test-user", roles: ["user"] });
const unauthedApp = () => createTestApp();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /:pluginId/test", () => {
  it("returns 401 without session", async () => {
    const app = unauthedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { botToken: "abc" } }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for unsupported channel", async () => {
    const app = authedApp();
    const res = await app.request("/twitch/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { token: "abc" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unsupported channel");
  });

  it("returns 400 for invalid JSON", async () => {
    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns success: true for valid Discord token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { botToken: "valid-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns success: false for invalid Discord token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { botToken: "bad-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("Invalid bot token");
    vi.unstubAllGlobals();
  });

  it("returns success: false when Discord token is missing", async () => {
    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("Bot token is required");
  });

  it("returns success: true for valid Telegram token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    const app = authedApp();
    const res = await app.request("/telegram/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { botToken: "123456:ABC-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns success: true for valid Slack token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    const app = authedApp();
    const res = await app.request("/slack/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { oauthToken: "xoxb-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    vi.unstubAllGlobals();
  });
});
