import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  platformDefaultLimit,
  platformRateLimitRules,
  type RateLimitConfig,
  type RateLimitRule,
  rateLimit,
  rateLimitByRoute,
} from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Hono app with a single rate-limited GET /test route. */
function buildApp(cfg: RateLimitConfig) {
  const app = new Hono();
  app.use("/test", rateLimit(cfg));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

function req(path = "/test", ip = "127.0.0.1") {
  return new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

function postReq(path: string, ip = "127.0.0.1") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

// ---------------------------------------------------------------------------
// rateLimit (single-route)
// ---------------------------------------------------------------------------

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", async () => {
    const app = buildApp({ max: 3 });

    for (let i = 0; i < 3; i++) {
      const res = await app.request(req());
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = buildApp({ max: 2 });

    await app.request(req());
    await app.request(req());
    const res = await app.request(req());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many requests");
  });

  it("sets X-RateLimit-* headers on every response", async () => {
    const app = buildApp({ max: 5 });
    const res = await app.request(req());

    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("sets Retry-After header on 429", async () => {
    const app = buildApp({ max: 1 });

    await app.request(req());
    const res = await app.request(req());

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("resets the window after windowMs elapses", async () => {
    const app = buildApp({ max: 1, windowMs: 10_000 });

    const res1 = await app.request(req());
    expect(res1.status).toBe(200);

    const res2 = await app.request(req());
    expect(res2.status).toBe(429);

    // Advance time past the window
    vi.advanceTimersByTime(10_001);

    const res3 = await app.request(req());
    expect(res3.status).toBe(200);
  });

  it("tracks different IPs independently", async () => {
    const app = buildApp({ max: 1 });

    const res1 = await app.request(req("/test", "10.0.0.1"));
    expect(res1.status).toBe(200);

    const res2 = await app.request(req("/test", "10.0.0.2"));
    expect(res2.status).toBe(200);

    // First IP is now rate limited
    const res3 = await app.request(req("/test", "10.0.0.1"));
    expect(res3.status).toBe(429);
  });

  it("uses a custom message when provided", async () => {
    const app = buildApp({ max: 1, message: "Slow down" });

    await app.request(req());
    const res = await app.request(req());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Slow down");
  });

  it("supports custom key generator", async () => {
    const app = new Hono();
    app.use("/test", rateLimit({ max: 1, keyGenerator: (c) => c.req.header("x-api-key") ?? "anon" }));
    app.get("/test", (c) => c.json({ ok: true }));

    const r1 = new Request("http://localhost/test", { headers: { "x-api-key": "key-a" } });
    const r2 = new Request("http://localhost/test", { headers: { "x-api-key": "key-b" } });
    const r3 = new Request("http://localhost/test", { headers: { "x-api-key": "key-a" } });

    expect((await app.request(r1)).status).toBe(200);
    expect((await app.request(r2)).status).toBe(200);
    expect((await app.request(r3)).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// rateLimitByRoute (multi-route)
// ---------------------------------------------------------------------------

describe("rateLimitByRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies rule-specific limits based on path prefix", async () => {
    const rules: RateLimitRule[] = [{ method: "POST", pathPrefix: "/strict", config: { max: 1 } }];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 100 }));
    app.post("/strict", (c) => c.json({ ok: true }));
    app.get("/lenient", (c) => c.json({ ok: true }));

    // Strict route: 1 allowed, then 429
    expect((await app.request(postReq("/strict"))).status).toBe(200);
    expect((await app.request(postReq("/strict"))).status).toBe(429);

    // Lenient route: still allowed (separate store)
    expect((await app.request(req("/lenient"))).status).toBe(200);
  });

  it("falls back to default config when no rule matches", async () => {
    const rules: RateLimitRule[] = [{ method: "POST", pathPrefix: "/special", config: { max: 1 } }];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 2 }));
    app.get("/other", (c) => c.json({ ok: true }));

    expect((await app.request(req("/other"))).status).toBe(200);
    expect((await app.request(req("/other"))).status).toBe(200);
    expect((await app.request(req("/other"))).status).toBe(429);
  });

  it("matches method correctly (wildcard vs specific)", async () => {
    const rules: RateLimitRule[] = [
      { method: "*", pathPrefix: "/any-method", config: { max: 1 } },
      { method: "GET", pathPrefix: "/get-only", config: { max: 1 } },
    ];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 100 }));
    app.get("/any-method", (c) => c.json({ ok: true }));
    app.post("/any-method", (c) => c.json({ ok: true }));
    app.get("/get-only", (c) => c.json({ ok: true }));
    app.post("/get-only", (c) => c.json({ ok: true }));

    // Wildcard matches both GET and POST
    expect((await app.request(req("/any-method"))).status).toBe(200);
    expect((await app.request(postReq("/any-method"))).status).toBe(429);

    // GET-only rule matches GET but not POST
    expect((await app.request(req("/get-only"))).status).toBe(200);
    expect((await app.request(req("/get-only"))).status).toBe(429);

    // POST to /get-only falls through to default (max: 100)
    expect((await app.request(postReq("/get-only"))).status).toBe(200);
  });

  it("first matching rule wins", async () => {
    const rules: RateLimitRule[] = [
      { method: "POST", pathPrefix: "/api/billing/checkout", config: { max: 2 } },
      { method: "POST", pathPrefix: "/api/billing", config: { max: 100 } },
    ];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 100 }));
    app.post("/api/billing/checkout", (c) => c.json({ ok: true }));

    expect((await app.request(postReq("/api/billing/checkout"))).status).toBe(200);
    expect((await app.request(postReq("/api/billing/checkout"))).status).toBe(200);
    expect((await app.request(postReq("/api/billing/checkout"))).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Platform rules integration
// ---------------------------------------------------------------------------

describe("platform rate limit rules", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildPlatformApp() {
    const app = new Hono();
    app.use("*", rateLimitByRoute(platformRateLimitRules, platformDefaultLimit));
    // Register routes that match the platform layout
    app.post("/api/validate-key", (c) => c.json({ ok: true }));
    app.post("/api/billing/checkout", (c) => c.json({ ok: true }));
    app.post("/api/billing/portal", (c) => c.json({ ok: true }));
    app.post("/fleet/bots", (c) => c.json({ ok: true }));
    app.get("/fleet/bots", (c) => c.json({ ok: true }));
    app.get("/fleet/bots/:id", (c) => c.json({ ok: true }));
    app.post("/auth/login", (c) => c.json({ ok: true }));
    app.get("/api/quota", (c) => c.json({ ok: true }));
    return app;
  }

  it("secrets validation is limited to 5 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 5; i++) {
      expect((await app.request(postReq("/api/validate-key"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/validate-key"))).status).toBe(429);
  });

  it("billing checkout is limited to 10 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 10; i++) {
      expect((await app.request(postReq("/api/billing/checkout"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/billing/checkout"))).status).toBe(429);
  });

  it("billing portal is limited to 10 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 10; i++) {
      expect((await app.request(postReq("/api/billing/portal"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/billing/portal"))).status).toBe(429);
  });

  it("fleet create (POST /fleet/bots) is limited to 30 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 30; i++) {
      expect((await app.request(postReq("/fleet/bots"))).status).toBe(200);
    }
    expect((await app.request(postReq("/fleet/bots"))).status).toBe(429);
  });

  it("fleet reads (GET /fleet/*) are limited to 120 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 120; i++) {
      expect((await app.request(req("/fleet/bots"))).status).toBe(200);
    }
    expect((await app.request(req("/fleet/bots"))).status).toBe(429);
  });

  it("auth endpoints are limited to 10 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 10; i++) {
      expect((await app.request(postReq("/auth/login"))).status).toBe(200);
    }
    expect((await app.request(postReq("/auth/login"))).status).toBe(429);
  });

  it("unmatched endpoints fall back to 60 req/min default", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 60; i++) {
      expect((await app.request(req("/api/quota"))).status).toBe(200);
    }
    expect((await app.request(req("/api/quota"))).status).toBe(429);
  });

  it("429 response includes Retry-After header", async () => {
    const app = buildPlatformApp();
    // Exhaust secrets validation limit (5)
    for (let i = 0; i < 5; i++) {
      await app.request(postReq("/api/validate-key"));
    }
    const res = await app.request(postReq("/api/validate-key"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
