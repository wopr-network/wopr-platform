/**
 * Tests for per-capability rate limiting middleware.
 */

import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleRateLimitRepository } from "../api/drizzle-rate-limit-repository.js";
import type { IRateLimitRepository } from "../api/rate-limit-repository.js";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { capabilityRateLimit, resolveCapabilityCategory } from "./capability-rate-limit.js";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenant(id: string): GatewayTenant {
  return { id, spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null } };
}

/**
 * Build a minimal Hono app with the capability rate limiter applied,
 * returning 200 OK for all routes.
 */
function makeApp(config: Parameters<typeof capabilityRateLimit>[0], repo: IRateLimitRepository) {
  const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
  app.use("/*", (c, next) => {
    // Inject tenant from X-Tenant-Id header (test convenience)
    const tenantId = c.req.header("x-tenant-id") ?? "tenant-a";
    c.set("gatewayTenant", makeTenant(tenantId));
    return next();
  });
  app.use("/*", capabilityRateLimit(config, repo));
  app.all("/*", (c) => c.json({ ok: true }, 200));
  return app;
}

type TestApp = ReturnType<typeof makeApp>;

async function sendRequests(app: TestApp, path: string, count: number, tenantId = "tenant-a") {
  const results: Response[] = [];
  for (let i = 0; i < count; i++) {
    results.push(
      await app.request(path, {
        method: "POST",
        headers: { "x-tenant-id": tenantId },
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// resolveCapabilityCategory
// ---------------------------------------------------------------------------

describe("resolveCapabilityCategory", () => {
  it("maps /chat/completions to llm", () => {
    expect(resolveCapabilityCategory("/chat/completions")).toBe("llm");
  });

  it("maps /completions to llm", () => {
    expect(resolveCapabilityCategory("/completions")).toBe("llm");
  });

  it("maps /embeddings to llm", () => {
    expect(resolveCapabilityCategory("/embeddings")).toBe("llm");
  });

  it("maps /images/generations to imageGen", () => {
    expect(resolveCapabilityCategory("/images/generations")).toBe("imageGen");
  });

  it("maps /video/generations to imageGen", () => {
    expect(resolveCapabilityCategory("/video/generations")).toBe("imageGen");
  });

  it("maps /audio/transcriptions to audioSpeech", () => {
    expect(resolveCapabilityCategory("/audio/transcriptions")).toBe("audioSpeech");
  });

  it("maps /audio/speech to audioSpeech", () => {
    expect(resolveCapabilityCategory("/audio/speech")).toBe("audioSpeech");
  });

  it("maps /phone/outbound to telephony", () => {
    expect(resolveCapabilityCategory("/phone/outbound")).toBe("telephony");
  });

  it("maps /messages/sms to telephony", () => {
    expect(resolveCapabilityCategory("/messages/sms")).toBe("telephony");
  });

  it("returns null for unknown path /models", () => {
    expect(resolveCapabilityCategory("/models")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// capabilityRateLimit middleware
// ---------------------------------------------------------------------------

describe("capabilityRateLimit", () => {
  let repo: IRateLimitRepository;
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("allows requests under the llm limit", async () => {
    const app = makeApp({ llm: 5 }, repo);
    const results = await sendRequests(app, "/chat/completions", 5);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("returns 429 when llm limit exceeded", async () => {
    const app = makeApp({ llm: 3 }, repo);
    const results = await sendRequests(app, "/chat/completions", 4);
    const statuses = results.map((r) => r.status);
    // First 3 pass, 4th is 429
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it("returns 429 with Retry-After header when llm limit exceeded", async () => {
    const app = makeApp({ llm: 2 }, repo);
    const results = await sendRequests(app, "/chat/completions", 3);
    const last = results[2];
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).not.toBeNull();
  });

  it("returns 429 when imageGen limit exceeded", async () => {
    const app = makeApp({ imageGen: 2 }, repo);
    const results = await sendRequests(app, "/images/generations", 3);
    expect(results[2].status).toBe(429);
  });

  it("returns 429 when audioSpeech limit exceeded", async () => {
    const app = makeApp({ audioSpeech: 2 }, repo);
    const results = await sendRequests(app, "/audio/speech", 3);
    expect(results[2].status).toBe(429);
  });

  it("different capabilities have independent counters", async () => {
    // Max out LLM, image requests should still pass
    const app = makeApp({ llm: 2, imageGen: 10 }, repo);
    await sendRequests(app, "/chat/completions", 2); // exhaust LLM
    const imageResp = await app.request("/images/generations", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a" },
    });
    expect(imageResp.status).toBe(200);
  });

  it("different tenants have independent counters", async () => {
    const app = makeApp({ llm: 2 }, repo);
    // Exhaust tenant-a
    await sendRequests(app, "/chat/completions", 2, "tenant-a");
    // tenant-b should still pass
    const resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-b" },
    });
    expect(resp.status).toBe(200);
  });

  it("sets rate limit headers on successful responses", async () => {
    const app = makeApp({ llm: 10 }, repo);
    const resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-ratelimit-limit")).not.toBeNull();
    expect(resp.headers.get("x-ratelimit-remaining")).not.toBeNull();
    expect(resp.headers.get("x-ratelimit-reset")).not.toBeNull();
  });

  it("sets rate limit headers on 429 responses", async () => {
    const app = makeApp({ llm: 1 }, repo);
    await sendRequests(app, "/chat/completions", 1);
    const resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a" },
    });
    expect(resp.status).toBe(429);
    expect(resp.headers.get("x-ratelimit-limit")).toBe("1");
    expect(resp.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("does not rate-limit unknown paths", async () => {
    const app = makeApp({ llm: 1 }, repo);
    // /models is not a known capability path, should never get 429
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request("/models", {
          method: "GET",
          headers: { "x-tenant-id": "tenant-a" },
        }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("respects custom config overrides", async () => {
    const app = makeApp({ llm: 5 }, repo);
    // Should allow exactly 5 requests before blocking
    const results = await sendRequests(app, "/chat/completions", 6);
    expect(results[4].status).toBe(200);
    expect(results[5].status).toBe(429);
  });

  it("window resets after windowMs", async () => {
    vi.useFakeTimers();
    const app = makeApp({ llm: 2 }, repo);

    // Exhaust the limit
    await sendRequests(app, "/chat/completions", 2);
    let resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a" },
    });
    expect(resp.status).toBe(429);

    // Advance past the window (60 seconds)
    vi.advanceTimersByTime(61_000);

    // Should be allowed again
    resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a" },
    });
    expect(resp.status).toBe(200);

    vi.useRealTimers();
  });
});
