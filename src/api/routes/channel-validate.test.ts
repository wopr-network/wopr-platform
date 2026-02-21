import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, AuthUser } from "../../auth/index.js";
import { channelValidateRoutes } from "./channel-validate.js";

function createTestApp(user?: AuthUser) {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
      c.set("authMethod", "session");
    }
    return next();
  });
  app.route("/", channelValidateRoutes);
  return app;
}

const authedApp = () => createTestApp({ id: "test-user-id", roles: ["user"] });
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
      body: JSON.stringify({ credentials: { discord_bot_token: "abc" } }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing credentials field", async () => {
    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("validates Discord token against Discord API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: "123", username: "TestBot" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { discord_bot_token: "valid-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        headers: { Authorization: "Bot valid-token" },
      }),
    );
  });

  it("returns error for invalid Discord token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ message: "401: Unauthorized" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { discord_bot_token: "bad-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Invalid Discord bot token" });
  });

  it("validates Telegram token against Telegram API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { id: 123, is_bot: true, first_name: "TestBot" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/telegram/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { telegram_bot_token: "123:ABC" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:ABC/getMe",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns error for invalid Telegram token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: false, description: "Unauthorized" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/telegram/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { telegram_bot_token: "bad" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Invalid Telegram bot token" });
  });

  it("validates Slack token against Slack API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, user_id: "U123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/slack/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { slack_bot_token: "xoxb-test" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-test" }),
      }),
    );
  });

  it("returns success for unsupported channels (format-only)", async () => {
    const app = authedApp();
    const res = await app.request("/signal/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { signal_phone: "+1234567890" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });

  it("handles fetch timeout gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { discord_bot_token: "valid-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("timed out");
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const app = authedApp();
    const res = await app.request("/discord/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { discord_bot_token: "valid-token" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("Could not reach");
  });
});
