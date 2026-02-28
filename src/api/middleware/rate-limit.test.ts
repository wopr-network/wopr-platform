import type { PGlite } from "@electric-sql/pglite";
import { type Context, Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleRateLimitRepository } from "../drizzle-rate-limit-repository.js";
import type { IRateLimitRepository } from "../rate-limit-repository.js";
import {
  getClientIp,
  parseTrustedProxies,
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
function buildApp(cfg: Omit<RateLimitConfig, "repo" | "scope">, repo: IRateLimitRepository) {
  const app = new Hono();
  app.use("/test", rateLimit({ ...cfg, repo, scope: "test" }));
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
// Shared PGlite instance (one pool for the entire file)
// ---------------------------------------------------------------------------

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

// ---------------------------------------------------------------------------
// rateLimit (single-route)
// ---------------------------------------------------------------------------

describe("rateLimit", () => {
  let repo: IRateLimitRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", async () => {
    const app = buildApp({ max: 3 }, repo);

    for (let i = 0; i < 3; i++) {
      const res = await app.request(req());
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = buildApp({ max: 2 }, repo);

    await app.request(req());
    await app.request(req());
    const res = await app.request(req());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many requests");
  });

  it("sets X-RateLimit-* headers on every response", async () => {
    const app = buildApp({ max: 5 }, repo);
    const res = await app.request(req());

    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("sets Retry-After header on 429", async () => {
    const app = buildApp({ max: 1 }, repo);

    await app.request(req());
    const res = await app.request(req());

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("resets the window after windowMs elapses", async () => {
    const app = buildApp({ max: 1, windowMs: 10_000 }, repo);

    const res1 = await app.request(req());
    expect(res1.status).toBe(200);

    const res2 = await app.request(req());
    expect(res2.status).toBe(429);

    vi.advanceTimersByTime(10_001);

    const res3 = await app.request(req());
    expect(res3.status).toBe(200);
  });

  it("tracks different IPs independently", async () => {
    const app = new Hono();
    app.use(
      "/test",
      rateLimit({ max: 1, repo, scope: "test", keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown" }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request(req("/test", "10.0.0.1"));
    expect(res1.status).toBe(200);

    const res2 = await app.request(req("/test", "10.0.0.2"));
    expect(res2.status).toBe(200);

    const res3 = await app.request(req("/test", "10.0.0.1"));
    expect(res3.status).toBe(429);
  });

  it("uses a custom message when provided", async () => {
    const app = buildApp({ max: 1, message: "Slow down" }, repo);

    await app.request(req());
    const res = await app.request(req());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Slow down");
  });

  it("supports custom key generator", async () => {
    const app = new Hono();
    app.use(
      "/test",
      rateLimit({ max: 1, repo, scope: "api-key", keyGenerator: (c) => c.req.header("x-api-key") ?? "anon" }),
    );
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
  let repo: IRateLimitRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies rule-specific limits based on path prefix", async () => {
    const rules: RateLimitRule[] = [{ method: "POST", pathPrefix: "/strict", config: { max: 1 }, scope: "strict" }];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 100 }, repo));
    app.post("/strict", (c) => c.json({ ok: true }));
    app.get("/lenient", (c) => c.json({ ok: true }));

    expect((await app.request(postReq("/strict"))).status).toBe(200);
    expect((await app.request(postReq("/strict"))).status).toBe(429);
    expect((await app.request(req("/lenient"))).status).toBe(200);
  });

  it("falls back to default config when no rule matches", async () => {
    const rules: RateLimitRule[] = [{ method: "POST", pathPrefix: "/special", config: { max: 1 }, scope: "special" }];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 2 }, repo));
    app.get("/other", (c) => c.json({ ok: true }));

    expect((await app.request(req("/other"))).status).toBe(200);
    expect((await app.request(req("/other"))).status).toBe(200);
    expect((await app.request(req("/other"))).status).toBe(429);
  });

  it("matches method correctly (wildcard vs specific)", async () => {
    const rules: RateLimitRule[] = [
      { method: "*", pathPrefix: "/any-method", config: { max: 1 }, scope: "any-method" },
      { method: "GET", pathPrefix: "/get-only", config: { max: 1 }, scope: "get-only" },
    ];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 100 }, repo));
    app.get("/any-method", (c) => c.json({ ok: true }));
    app.post("/any-method", (c) => c.json({ ok: true }));
    app.get("/get-only", (c) => c.json({ ok: true }));
    app.post("/get-only", (c) => c.json({ ok: true }));

    expect((await app.request(req("/any-method"))).status).toBe(200);
    expect((await app.request(postReq("/any-method"))).status).toBe(429);
    expect((await app.request(req("/get-only"))).status).toBe(200);
    expect((await app.request(req("/get-only"))).status).toBe(429);
    expect((await app.request(postReq("/get-only"))).status).toBe(200);
  });

  it("first matching rule wins", async () => {
    const rules: RateLimitRule[] = [
      { method: "POST", pathPrefix: "/api/billing/checkout", config: { max: 2 }, scope: "billing:checkout" },
      { method: "POST", pathPrefix: "/api/billing", config: { max: 100 }, scope: "billing" },
    ];
    const app = new Hono();
    app.use("*", rateLimitByRoute(rules, { max: 100 }, repo));
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
  let repo: IRateLimitRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildPlatformApp() {
    const app = new Hono();
    app.use("*", rateLimitByRoute(platformRateLimitRules, platformDefaultLimit, repo));
    app.post("/api/validate-key", (c) => c.json({ ok: true }));
    app.post("/api/billing/credits/checkout", (c) => c.json({ ok: true }));
    app.post("/api/billing/portal", (c) => c.json({ ok: true }));
    app.post("/fleet/bots", (c) => c.json({ ok: true }));
    app.get("/fleet/bots", (c) => c.json({ ok: true }));
    app.get("/fleet/bots/:id", (c) => c.json({ ok: true }));
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
      expect((await app.request(postReq("/api/billing/credits/checkout"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/billing/credits/checkout"))).status).toBe(429);
  });

  it("billing portal is limited to 10 req/min", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 10; i++) {
      expect((await app.request(postReq("/api/billing/portal"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/billing/portal"))).status).toBe(429);
  });

  it("webhook endpoint is limited to 30 req/min", async () => {
    const app = buildPlatformApp();
    app.post("/api/billing/webhook", (c) => c.json({ ok: true }));
    for (let i = 0; i < 30; i++) {
      expect((await app.request(postReq("/api/billing/webhook"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/billing/webhook"))).status).toBe(429);
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

  it("unmatched endpoints fall back to 60 req/min default", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 60; i++) {
      expect((await app.request(req("/api/quota"))).status).toBe(200);
    }
    expect((await app.request(req("/api/quota"))).status).toBe(429);
  });

  it("429 response includes Retry-After header", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 5; i++) {
      await app.request(postReq("/api/validate-key"));
    }
    const res = await app.request(postReq("/api/validate-key"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Auth endpoint rate limits (WOP-839)
// ---------------------------------------------------------------------------

describe("auth endpoint rate limits (WOP-839)", () => {
  let repo: IRateLimitRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildPlatformApp() {
    const app = new Hono();
    app.use("*", rateLimitByRoute(platformRateLimitRules, platformDefaultLimit, repo));
    app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
    app.post("/api/auth/sign-up/email", (c) => c.json({ ok: true }));
    app.post("/api/auth/request-password-reset", (c) => c.json({ ok: true }));
    return app;
  }

  it("locks out after 5 login attempts within 15 minutes", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 5; i++) {
      expect((await app.request(postReq("/api/auth/sign-in/email"))).status).toBe(200);
    }
    const res = await app.request(postReq("/api/auth/sign-in/email"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("login attempts");
  });

  it("returns rate limit headers on auth login responses", async () => {
    const app = buildPlatformApp();
    const res = await app.request(postReq("/api/auth/sign-in/email"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("returns Retry-After header on login lockout", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 5; i++) {
      await app.request(postReq("/api/auth/sign-in/email"));
    }
    const res = await app.request(postReq("/api/auth/sign-in/email"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("resets login limit after 15-minute window", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 5; i++) {
      await app.request(postReq("/api/auth/sign-in/email"));
    }
    expect((await app.request(postReq("/api/auth/sign-in/email"))).status).toBe(429);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    expect((await app.request(postReq("/api/auth/sign-in/email"))).status).toBe(200);
  });

  it("tracks login attempts per IP independently", async () => {
    const xffKeyGen = (c: Context) => c.req.header("x-forwarded-for") ?? "unknown";
    const rulesWithKeyGen = platformRateLimitRules.map((rule) =>
      rule.scope === "auth:login" ? { ...rule, config: { ...rule.config, keyGenerator: xffKeyGen } } : rule,
    );
    const app = new Hono();
    app.use("*", rateLimitByRoute(rulesWithKeyGen, platformDefaultLimit, repo));
    app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      await app.request(postReq("/api/auth/sign-in/email", "10.0.0.1"));
    }
    expect((await app.request(postReq("/api/auth/sign-in/email", "10.0.0.1"))).status).toBe(429);
    expect((await app.request(postReq("/api/auth/sign-in/email", "10.0.0.2"))).status).toBe(200);
  });

  it("limits signup to 10 per hour per IP", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 10; i++) {
      expect((await app.request(postReq("/api/auth/sign-up/email"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/auth/sign-up/email"))).status).toBe(429);
  });

  it("limits password reset to 3 per hour per IP", async () => {
    const app = buildPlatformApp();
    for (let i = 0; i < 3; i++) {
      expect((await app.request(postReq("/api/auth/request-password-reset"))).status).toBe(200);
    }
    expect((await app.request(postReq("/api/auth/request-password-reset"))).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Trusted proxy validation (WOP-656)
// ---------------------------------------------------------------------------

describe("trusted proxy validation (WOP-656)", () => {
  let repo: IRateLimitRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores X-Forwarded-For when TRUSTED_PROXY_IPS is not set", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(trusted.size).toBe(0);

    const ip = getClientIp("spoofed-ip", "192.168.1.100", trusted);
    expect(ip).toBe("192.168.1.100");
  });

  it("trusts X-Forwarded-For when socket address is in TRUSTED_PROXY_IPS", () => {
    const trusted = parseTrustedProxies("172.18.0.5,10.0.0.1");
    expect(trusted.size).toBe(2);

    const ip = getClientIp("real-client-ip", "172.18.0.5", trusted);
    expect(ip).toBe("real-client-ip");
  });

  it("strips ::ffff: prefix when matching trusted proxies", () => {
    const trusted = parseTrustedProxies("172.18.0.5");

    const ip = getClientIp("real-client-ip", "::ffff:172.18.0.5", trusted);
    expect(ip).toBe("real-client-ip");
  });

  it("falls back to socket address when socket is not a trusted proxy", () => {
    const trusted = parseTrustedProxies("172.18.0.5");

    const ip = getClientIp("spoofed-ip", "evil-direct-client", trusted);
    expect(ip).toBe("evil-direct-client");
  });

  it("uses last XFF value (rightmost) when proxy is trusted", () => {
    const trusted = parseTrustedProxies("172.18.0.5");

    const ip = getClientIp("fake, real-client", "172.18.0.5", trusted);
    expect(ip).toBe("real-client");
  });

  it("returns 'unknown' when no socket address and no trusted proxy", () => {
    const trusted = parseTrustedProxies(undefined);
    const ip = getClientIp(undefined, undefined, trusted);
    expect(ip).toBe("unknown");
  });

  it("rate limits by socket IP when XFF is spoofed without trusted proxy", async () => {
    delete process.env.TRUSTED_PROXY_IPS;

    const app = new Hono();
    app.use("/test", rateLimit({ max: 1, repo, scope: "test" }));
    app.get("/test", (c) => c.json({ ok: true }));

    const r1 = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": "attacker-ip-1" },
    });
    const r2 = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": "attacker-ip-2" },
    });

    const res1 = await app.request(r1);
    expect(res1.status).toBe(200);

    const res2 = await app.request(r2);
    expect(res2.status).toBe(429);
  });
});

describe("platformRateLimitRules — billing checkout path", () => {
  it("checkout rule matches /api/billing/credits/checkout", async () => {
    const { repo, pool } = await makeRateLimitRepo();
    try {
      const app = new Hono();
      app.use("*", rateLimitByRoute(platformRateLimitRules, platformDefaultLimit, repo));
      // Dummy handler — we only care about rate-limit headers
      app.post("/api/billing/credits/checkout", (c) => c.json({ ok: true }));

      // The BILLING_LIMIT is max: 10. Send 10 requests — all must pass.
      for (let i = 0; i < 10; i++) {
        const res = await app.request(postReq("/api/billing/credits/checkout", "10.0.0.99"));
        expect(res.status).toBe(200);
      }

      const blocked = await app.request(postReq("/api/billing/credits/checkout", "10.0.0.99"));
      expect(blocked.status).toBe(429);
    } finally {
      await pool.close();
    }
  });
});
