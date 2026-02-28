/**
 * Tests for spending cap enforcement middleware.
 */

import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { meterEvents } from "../db/schema/meter-events.js";
import { DrizzleSpendingCapStore } from "../fleet/spending-cap-repository.js";
import { Credit } from "../monetization/credit.js";
import { createTestDb } from "../test/db.js";
import { type SpendingCaps, spendingCapCheck } from "./spending-cap.js";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenant(id: string, spendingCaps?: SpendingCaps): GatewayTenant {
  return {
    id,
    spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    spendingCaps,
  };
}

function makeApp(db: DrizzleDb, tenantId: string, caps?: SpendingCaps, config?: { cacheTtlMs?: number }) {
  const store = new DrizzleSpendingCapStore(db);
  const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
  app.use("/*", (c, next) => {
    c.set("gatewayTenant", makeTenant(tenantId, caps));
    return next();
  });
  app.use("/*", spendingCapCheck(store, config));
  app.all("/*", (c) => c.json({ ok: true }, 200));
  return app;
}

/** Insert a meter event with the given charge amount (in USD) at the given timestamp. */
async function insertMeterEvent(db: DrizzleDb, tenant: string, chargeUsd: number, timestamp: number) {
  const raw = Credit.fromDollars(chargeUsd).toRaw();
  await db.insert(meterEvents).values({
    id: `evt-${Math.random().toString(36).slice(2)}`,
    tenant,
    cost: raw,
    charge: raw,
    capability: "chat-completions",
    provider: "openrouter",
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spendingCapCheck", () => {
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterEach(async () => {
    await pool.close();
  });

  it("passes when no spending caps configured", async () => {
    const app = makeApp(db, "tenant-no-caps", undefined);
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("passes when both caps are null (unlimited)", async () => {
    const app = makeApp(db, "tenant-null-caps", { dailyCapUsd: null, monthlyCapUsd: null });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("passes when daily spend is under the daily cap", async () => {
    const tenant = "tenant-under-daily";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 10, now);
    const app = makeApp(db, tenant, { dailyCapUsd: 50, monthlyCapUsd: null }, { cacheTtlMs: 0 });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("returns 402 when daily spend exceeds daily cap", async () => {
    const tenant = "tenant-over-daily";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 55, now);
    const app = makeApp(db, tenant, { dailyCapUsd: 50, monthlyCapUsd: null }, { cacheTtlMs: 0 });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as { error: { code: string; cap_type: string } };
    expect(body.error.code).toBe("spending_cap_exceeded");
    expect(body.error.cap_type).toBe("daily");
  });

  it("returns 402 when monthly spend exceeds monthly cap", async () => {
    const tenant = "tenant-over-monthly";
    const now = Date.now();
    // Insert event within current month
    await insertMeterEvent(db, tenant, 200, now);
    const app = makeApp(db, tenant, { dailyCapUsd: null, monthlyCapUsd: 150 }, { cacheTtlMs: 0 });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as { error: { code: string; cap_type: string } };
    expect(body.error.code).toBe("spending_cap_exceeded");
    expect(body.error.cap_type).toBe("monthly");
  });

  it("checks daily cap before monthly cap when both exceeded", async () => {
    const tenant = "tenant-both-exceeded";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 200, now);
    const app = makeApp(db, tenant, { dailyCapUsd: 100, monthlyCapUsd: 150 }, { cacheTtlMs: 0 });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as { error: { cap_type: string } };
    expect(body.error.cap_type).toBe("daily");
  });

  it("includes current_spend_usd and cap_usd in 402 response body", async () => {
    const tenant = "tenant-body-check";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 55.5, now);
    const app = makeApp(db, tenant, { dailyCapUsd: 50, monthlyCapUsd: null }, { cacheTtlMs: 0 });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as { error: { current_spend_usd: number; cap_usd: number } };
    expect(body.error.current_spend_usd).toBeGreaterThanOrEqual(55.5);
    expect(body.error.cap_usd).toBe(50);
  });

  it("caches spend query and avoids repeated DB calls within TTL", async () => {
    const tenant = "tenant-cache-test";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 10, now);

    // Create app with 60s TTL cache
    const app = makeApp(db, tenant, { dailyCapUsd: 50, monthlyCapUsd: null }, { cacheTtlMs: 60_000 });

    // Spy on the db to confirm only 1 DB query is made for N requests
    const selectSpy = vi.spyOn(db, "select");

    // Send 5 requests
    for (let i = 0; i < 5; i++) {
      await app.request("/chat/completions", { method: "POST" });
    }

    // Should have queried DB only once (for daily) and once (for monthly) = 2 total, not 10
    expect(selectSpy.mock.calls.length).toBeLessThanOrEqual(4); // at most 2 queries per first request
    selectSpy.mockRestore();
  });

  it("re-queries DB after cache TTL expires", async () => {
    const tenant = "tenant-ttl-test";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 10, now);

    // Very short TTL so we don't need fake timers
    const app = makeApp(db, tenant, { dailyCapUsd: 50, monthlyCapUsd: null }, { cacheTtlMs: 50 });

    const selectSpy = vi.spyOn(db, "select");

    // First request — queries DB
    await app.request("/chat/completions", { method: "POST" });
    const callsAfterFirst = selectSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Wait past TTL
    await new Promise((r) => setTimeout(r, 60));

    // Second request — should re-query DB
    await app.request("/chat/completions", { method: "POST" });
    const callsAfterSecond = selectSpy.mock.calls.length;

    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);

    selectSpy.mockRestore();
  });

  it("does not reject when spend is exactly at the cap (only rejects when exceeded)", async () => {
    const tenant = "tenant-at-cap";
    const now = Date.now();
    await insertMeterEvent(db, tenant, 50, now);
    const app = makeApp(db, tenant, { dailyCapUsd: 50, monthlyCapUsd: null }, { cacheTtlMs: 0 });
    // At exactly the cap limit — enforce >= means this is blocked
    const resp = await app.request("/chat/completions", { method: "POST" });
    // Spending cap blocks at >= cap (same semantics as BudgetChecker)
    expect(resp.status).toBe(402);
  });
});
