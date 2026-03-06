import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { meterEvents } from "../../src/db/schema/meter-events.js";
import { Credit } from "../../src/monetization/credit.js";
import { DrizzleSpendingLimitsRepository } from "../../src/monetization/drizzle-spending-limits-repository.js";
import { DrizzleSpendingCapStore } from "../../src/fleet/spending-cap-repository.js";
import { spendingCapCheck, type SpendingCaps } from "../../src/gateway/spending-cap.js";
import { hydrateSpendingCaps } from "../../src/gateway/hydrate-spending-caps.js";
import type { GatewayTenant } from "../../src/gateway/types.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/** Insert a meter event with the given charge in USD at the given timestamp. */
async function insertMeterEvent(db: DrizzleDb, tenant: string, chargeUsd: number, timestamp: number) {
  const raw = Credit.fromDollars(chargeUsd).toRaw();
  await db.insert(meterEvents).values({
    id: `evt-${randomUUID()}`,
    tenant,
    cost: raw,
    charge: raw,
    capability: "chat-completions",
    provider: "openrouter",
    timestamp,
  });
}

function makeAppWithHydration(db: DrizzleDb, tenantId: string) {
  const limitsRepo = new DrizzleSpendingLimitsRepository(db);
  const capStore = new DrizzleSpendingCapStore(db);
  const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();

  app.use("/*", (c, next) => {
    c.set("gatewayTenant", {
      id: tenantId,
      spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    });
    return next();
  });
  app.use("/*", hydrateSpendingCaps(limitsRepo, { cacheTtlMs: 0, cacheMaxSize: 100 }));
  app.use("/*", spendingCapCheck(capStore, { cacheTtlMs: 0, cacheMaxSize: 100 }));
  app.all("/*", (c) => c.json({ ok: true }, 200));
  return { app, limitsRepo };
}

function makeAppWithExplicitCaps(db: DrizzleDb, tenantId: string, caps: SpendingCaps) {
  const capStore = new DrizzleSpendingCapStore(db);
  const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();

  app.use("/*", (c, next) => {
    c.set("gatewayTenant", {
      id: tenantId,
      spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
      spendingCaps: caps,
    });
    return next();
  });
  app.use("/*", spendingCapCheck(capStore, { cacheTtlMs: 0, cacheMaxSize: 100 }));
  app.all("/*", (c) => c.json({ ok: true }, 200));
  return app;
}

describe("E2E: spending limits enforce per-tenant caps on capability usage", () => {
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterEach(async () => {
    await pool.close();
  });

  it("allows request when tenant spend is under the daily cap", async () => {
    const tenantId = `e2e-spend-under-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await insertMeterEvent(db, tenantId, 5, now);

    const app = makeAppWithExplicitCaps(db, tenantId, { dailyCapUsd: 10, monthlyCapUsd: null });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("allows request when tenant spend is under the monthly cap (via hydration)", async () => {
    const tenantId = `e2e-spend-under-monthly-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await insertMeterEvent(db, tenantId, 50, now);

    const { app, limitsRepo } = makeAppWithHydration(db, tenantId);
    await limitsRepo.upsert(tenantId, {
      global: { alertAt: 80, hardCap: 100 },
      perCapability: {},
    });

    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("blocks request with 402 when daily spend reaches the daily cap", async () => {
    const tenantId = `e2e-spend-at-daily-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await insertMeterEvent(db, tenantId, 10, now);

    const app = makeAppWithExplicitCaps(db, tenantId, { dailyCapUsd: 10, monthlyCapUsd: null });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);

    const body = (await resp.json()) as { error: { code: string; cap_type: string; current_spend_usd: number; cap_usd: number } };
    expect(body.error.code).toBe("spending_cap_exceeded");
    expect(body.error.cap_type).toBe("daily");
    expect(body.error.current_spend_usd).toBeGreaterThanOrEqual(10);
    expect(body.error.cap_usd).toBe(10);
  });

  it("blocks request with 402 when daily spend exceeds the daily cap", async () => {
    const tenantId = `e2e-spend-over-daily-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await insertMeterEvent(db, tenantId, 15, now);

    const app = makeAppWithExplicitCaps(db, tenantId, { dailyCapUsd: 10, monthlyCapUsd: null });
    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);
  });

  it("blocks request with 402 when monthly spend reaches the monthly cap (via hydration)", async () => {
    const tenantId = `e2e-spend-at-monthly-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await insertMeterEvent(db, tenantId, 100, now);

    const { app, limitsRepo } = makeAppWithHydration(db, tenantId);
    await limitsRepo.upsert(tenantId, {
      global: { alertAt: 80, hardCap: 100 },
      perCapability: {},
    });

    const resp = await app.request("/chat/completions", { method: "POST" });
    expect(resp.status).toBe(402);

    const body = (await resp.json()) as { error: { code: string; cap_type: string } };
    expect(body.error.code).toBe("spending_cap_exceeded");
    expect(body.error.cap_type).toBe("monthly");
  });

  it("daily limits reset at midnight UTC — yesterday's spend does not count", async () => {
    const tenantId = `e2e-spend-reset-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const yesterdayTs = now - 25 * 60 * 60 * 1000;

    await insertMeterEvent(db, tenantId, 15, yesterdayTs);

    const app = makeAppWithExplicitCaps(db, tenantId, { dailyCapUsd: 10, monthlyCapUsd: null });
    const resp = await app.request("/chat/completions", { method: "POST" });

    expect(resp.status).toBe(200);
  });

  it("yesterday's spend still counts toward monthly cap", async () => {
    const tenantId = `e2e-spend-monthly-carries-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const yesterdayTs = now - 25 * 60 * 60 * 1000;
    await insertMeterEvent(db, tenantId, 100, yesterdayTs);

    const { app, limitsRepo } = makeAppWithHydration(db, tenantId);
    await limitsRepo.upsert(tenantId, {
      global: { alertAt: 40, hardCap: 50 },
      perCapability: {},
    });

    const resp = await app.request("/chat/completions", { method: "POST" });

    expect(resp.status).toBe(402);
  });

  it("tenant isolation — one tenant's spend does not affect another", async () => {
    const tenantA = `e2e-spend-iso-a-${randomUUID().slice(0, 8)}`;
    const tenantB = `e2e-spend-iso-b-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await insertMeterEvent(db, tenantA, 20, now);

    const appA = makeAppWithExplicitCaps(db, tenantA, { dailyCapUsd: 10, monthlyCapUsd: null });
    const appB = makeAppWithExplicitCaps(db, tenantB, { dailyCapUsd: 10, monthlyCapUsd: null });

    const respA = await appA.request("/chat/completions", { method: "POST" });
    const respB = await appB.request("/chat/completions", { method: "POST" });

    expect(respA.status).toBe(402);
    expect(respB.status).toBe(200);
  });
});
