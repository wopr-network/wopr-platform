/**
 * Tests for the spending-cap-store TTL cache layer.
 *
 * Tests the LRU cache behavior of spendingCapCheck in isolation using a mock
 * ISpendingCapStore — no DB required. Covers cache hit, TTL expiry, TTL
 * boundary, updated spend reflection, and concurrent request behavior.
 *
 * Note: lru-cache captures a reference to `performance` at module load time,
 * so vi.useFakeTimers() cannot advance its internal clock. We use real short
 * TTLs (20ms) with small real delays instead.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { type SpendingCaps, spendingCapCheck } from "./spending-cap.js";
import type { ISpendingCapStore, SpendingCapRecord } from "./spending-cap-store.js";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Short TTL used in all cache tests — fast enough for real waits. */
const TEST_TTL_MS = 20;

function makeMockStore(impl?: (tenant: string, now: number) => Promise<SpendingCapRecord>): ISpendingCapStore {
  const defaultImpl = async () => ({ dailySpend: 0, monthlySpend: 0 });
  return { querySpend: vi.fn(impl ?? defaultImpl) };
}

function makeTenant(id: string, caps?: SpendingCaps): GatewayTenant {
  return {
    id,
    spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    spendingCaps: caps,
  };
}

function makeApp(
  store: ISpendingCapStore,
  tenantId: string,
  caps?: SpendingCaps,
  config?: { cacheTtlMs?: number; cacheMaxSize?: number },
) {
  const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
  app.use("/*", (c, next) => {
    c.set("gatewayTenant", makeTenant(tenantId, caps));
    return next();
  });
  app.use("/*", spendingCapCheck(store, config));
  app.all("/*", (c) => c.json({ ok: true }, 200));
  return app;
}

function req(app: Hono<{ Variables: { gatewayTenant: GatewayTenant } }>) {
  return app.request("/chat/completions", { method: "POST" });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spending-cap-store TTL cache", () => {
  it("cache hit: second read within TTL returns cached value, no additional DB call", async () => {
    const store = makeMockStore();
    // Long TTL — 3 requests should all be cache hits after the first
    const app = makeApp(store, "t-1", { dailyCapUsd: 100, monthlyCapUsd: null }, { cacheTtlMs: 60_000 });

    await req(app);
    await req(app);
    await req(app);

    expect(store.querySpend).toHaveBeenCalledTimes(1);
  });

  it("cache miss: read after TTL expiry fetches fresh value from store", async () => {
    const store = makeMockStore();
    const app = makeApp(store, "t-2", { dailyCapUsd: 100, monthlyCapUsd: null }, { cacheTtlMs: TEST_TTL_MS });

    await req(app); // populates cache
    expect(store.querySpend).toHaveBeenCalledTimes(1);

    await sleep(TEST_TTL_MS * 2); // wait past TTL

    await req(app); // cache expired, queries again
    expect(store.querySpend).toHaveBeenCalledTimes(2);
  });

  it("TTL boundary: value within TTL is cached, value past TTL is fresh", async () => {
    const store = makeMockStore();
    const app = makeApp(store, "t-3", { dailyCapUsd: 100, monthlyCapUsd: null }, { cacheTtlMs: TEST_TTL_MS });

    await req(app); // T+0: populates cache
    expect(store.querySpend).toHaveBeenCalledTimes(1);

    // Well within TTL — still cached
    await req(app);
    expect(store.querySpend).toHaveBeenCalledTimes(1);

    await sleep(TEST_TTL_MS * 2); // past TTL

    await req(app);
    expect(store.querySpend).toHaveBeenCalledTimes(2); // fresh query
  });

  it("reflects updated spend after cache expires", async () => {
    let callCount = 0;
    const store = makeMockStore(async () => {
      callCount++;
      // First call: under cap. Second call: over cap.
      if (callCount === 1) return { dailySpend: 10, monthlySpend: 10 };
      return { dailySpend: 200, monthlySpend: 200 };
    });

    const app = makeApp(store, "t-4", { dailyCapUsd: 100, monthlyCapUsd: null }, { cacheTtlMs: TEST_TTL_MS });

    const r1 = await req(app);
    expect(r1.status).toBe(200); // under cap

    await sleep(TEST_TTL_MS * 2); // expire cache

    const r2 = await req(app);
    expect(r2.status).toBe(402); // over cap after fresh fetch
  });

  it("concurrent requests: cache populated by first request, subsequent requests use cache", async () => {
    const store = makeMockStore();
    const app = makeApp(store, "t-5", { dailyCapUsd: 100, monthlyCapUsd: null }, { cacheTtlMs: 60_000 });

    // Fire 10 concurrent requests
    const results = await Promise.all(Array.from({ length: 10 }, () => req(app)));

    // All should pass (under cap — store returns 0 spend)
    for (const r of results) {
      expect(r.status).toBe(200);
    }

    // lru-cache does NOT deduplicate in-flight async calls, so concurrent misses
    // each call querySpend independently. Assert at least 1 call was made.
    expect((store.querySpend as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);

    // After all concurrent requests resolve and cache is populated, the NEXT
    // request must NOT call querySpend again (cache hit).
    const callsBefore = (store.querySpend as ReturnType<typeof vi.fn>).mock.calls.length;
    const rNext = await req(app);
    expect(rNext.status).toBe(200);
    expect((store.querySpend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore); // cached
  });
});
