import type { SessionAuthEnv } from "@wopr-network/platform-core/auth/middleware";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { csrfProtection, validateCsrfOrigin } from "./csrf.js";

// ---------------------------------------------------------------------------
// validateCsrfOrigin unit tests
// ---------------------------------------------------------------------------

describe("validateCsrfOrigin", () => {
  function makeHeaders(headers: Record<string, string>): Headers {
    return new Headers(headers);
  }

  it("returns true when Origin matches allowed origin", () => {
    const result = validateCsrfOrigin(makeHeaders({ origin: "https://app.wopr.bot" }), ["https://app.wopr.bot"]);
    expect(result).toBe(true);
  });

  it("returns true when Origin matches one of multiple allowed origins", () => {
    const result = validateCsrfOrigin(makeHeaders({ origin: "https://staging.wopr.bot" }), [
      "https://app.wopr.bot",
      "https://staging.wopr.bot",
    ]);
    expect(result).toBe(true);
  });

  it("returns false when Origin does not match any allowed origin", () => {
    const result = validateCsrfOrigin(makeHeaders({ origin: "https://evil.com" }), ["https://app.wopr.bot"]);
    expect(result).toBe(false);
  });

  it("falls back to Referer when Origin is absent", () => {
    const result = validateCsrfOrigin(makeHeaders({ referer: "https://app.wopr.bot/dashboard" }), [
      "https://app.wopr.bot",
    ]);
    expect(result).toBe(true);
  });

  it("returns false when neither Origin nor Referer is present", () => {
    const result = validateCsrfOrigin(makeHeaders({}), ["https://app.wopr.bot"]);
    expect(result).toBe(false);
  });

  it("returns false for malformed Referer URL", () => {
    const result = validateCsrfOrigin(makeHeaders({ referer: "not-a-url" }), ["https://app.wopr.bot"]);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// csrfProtection middleware integration tests
// ---------------------------------------------------------------------------

describe("csrfProtection middleware", () => {
  function createApp(allowedOrigins: string[]) {
    const app = new Hono<SessionAuthEnv>();
    // Simulate session user being set (as resolveSessionUser does in production)
    // so CSRF validation logic actually runs in unit tests.
    app.use("/*", async (c, next) => {
      c.set("user", { id: "test-user", roles: ["user"] });
      return next();
    });
    app.use("/*", csrfProtection({ allowedOrigins }));
    app.post("/api/fleet/bots", (c) => c.json({ ok: true }));
    app.put("/api/billing/checkout", (c) => c.json({ ok: true }));
    app.delete("/fleet/bots/123", (c) => c.json({ ok: true }));
    app.get("/api/fleet/bots", (c) => c.json({ ok: true }));
    app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
    app.post("/api/billing/webhook", (c) => c.json({ ok: true }));
    app.post("/internal/nodes/register", (c) => c.json({ ok: true }));
    app.post("/health", (c) => c.json({ ok: true }));
    app.post("/trpc/fleet.create", (c) => c.json({ ok: true }));
    return app;
  }

  const origins = ["https://app.wopr.bot"];

  it("blocks POST without Origin header", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/fleet/bots", { method: "POST" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("CSRF validation failed");
  });

  it("blocks POST with wrong Origin", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/fleet/bots", {
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows POST with correct Origin", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/fleet/bots", {
      method: "POST",
      headers: { origin: "https://app.wopr.bot" },
    });
    expect(res.status).toBe(200);
  });

  it("allows GET requests without Origin", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/fleet/bots", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("blocks PUT without Origin", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/billing/checkout", { method: "PUT" });
    expect(res.status).toBe(403);
  });

  it("blocks DELETE without Origin", async () => {
    const app = createApp(origins);
    const res = await app.request("/fleet/bots/123", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("exempts /api/auth/* routes", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("exempts /api/billing/webhook", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/billing/webhook", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("exempts /internal/* routes", async () => {
    const app = createApp(origins);
    const res = await app.request("/internal/nodes/register", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("exempts /health routes", async () => {
    const app = createApp(origins);
    const res = await app.request("/health", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("skips CSRF check when Authorization Bearer header is present", async () => {
    const app = createApp(origins);
    const res = await app.request("/api/fleet/bots", {
      method: "POST",
      headers: { authorization: "Bearer some-token" },
    });
    expect(res.status).toBe(200);
  });

  it("protects /trpc/* mutation routes", async () => {
    const app = createApp(origins);
    const res = await app.request("/trpc/fleet.create", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("allows /trpc/* with correct Origin", async () => {
    const app = createApp(origins);
    const res = await app.request("/trpc/fleet.create", {
      method: "POST",
      headers: { origin: "https://app.wopr.bot" },
    });
    expect(res.status).toBe(200);
  });
});
