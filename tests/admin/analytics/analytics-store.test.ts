import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsStore } from "../../../src/admin/analytics/analytics-store.js";
import type { DrizzleDb } from "../../../src/db/index.js";
import { createTestDb, truncateAllTables } from "../../../src/test/db.js";

async function seedAutoTopup(
  pool: PGlite,
  tenantId: string,
  amountCents: number,
  status: "success" | "failed",
  createdAt: string,
  failureReason?: string,
): Promise<void> {
  await pool.query(
    "INSERT INTO credit_auto_topup (id, tenant_id, amount_cents, status, failure_reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [crypto.randomUUID(), tenantId, amountCents, status, failureReason ?? null, createdAt],
  );
}

async function seedCredits(
  pool: PGlite,
  tenantId: string,
  type: string,
  amountCents: number,
  createdAt: string,
): Promise<void> {
  // amount_credits and balance_after_credits store nanodollars (cents * 10_000_000)
  const amountCredits = amountCents * 10_000_000;
  await pool.query(
    "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [crypto.randomUUID(), tenantId, amountCredits, 0, type, createdAt],
  );
}

async function seedMeterEvent(
  pool: PGlite,
  tenant: string,
  capability: string,
  provider: string,
  cost: number,
  charge: number,
  timestamp: number,
): Promise<void> {
  await pool.query(
    "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [crypto.randomUUID(), tenant, cost, charge, capability, provider, timestamp],
  );
}

async function seedBalance(pool: PGlite, tenantId: string, balanceCents: number): Promise<void> {
  const balanceCredits = balanceCents * 10_000_000;
  await pool.query(
    "INSERT INTO credit_balances (tenant_id, balance_credits, last_updated) VALUES ($1, $2, NOW()) ON CONFLICT (tenant_id) DO UPDATE SET balance_credits = $2, last_updated = NOW()",
    [tenantId, balanceCredits],
  );
}

const NOW = Date.now();
const THIRTY_DAYS_AGO = NOW - 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_AGO = NOW - 60 * 24 * 60 * 60 * 1000;

const NOW_ISO = new Date(NOW).toISOString();
const THIRTY_DAYS_AGO_ISO = new Date(THIRTY_DAYS_AGO).toISOString();
const SIXTY_DAYS_AGO_ISO = new Date(SIXTY_DAYS_AGO).toISOString();

describe("AnalyticsStore — getRevenueOverview", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("returns all zeros for an empty database", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };
    const result = await store.getRevenueOverview(range);

    expect(result.creditsSoldCents).toBe(0);
    expect(result.revenueConsumedCents).toBe(0);
    expect(result.providerCostCents).toBe(0);
    expect(result.grossMarginCents).toBe(0);
    expect(result.grossMarginPct).toBe(0);
  });

  it("calculates revenue, cost, and margin correctly", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Purchase: $100 in credits
    await seedCredits(pool, "tenant-1", "purchase", 10000, NOW_ISO);
    // Consumed: $60 adapter_usage + $20 bot_runtime = $80
    await seedCredits(pool, "tenant-1", "adapter_usage", -6000, NOW_ISO);
    await seedCredits(pool, "tenant-1", "bot_runtime", -2000, NOW_ISO);
    // Provider cost: $30 → 3000 cents
    await seedMeterEvent(pool, "tenant-1", "chat", "openai", 0.3, 0.6, NOW);

    const result = await store.getRevenueOverview(range);

    expect(result.creditsSoldCents).toBe(10000);
    expect(result.revenueConsumedCents).toBe(8000);
    expect(result.providerCostCents).toBe(30); // 0.3 * 100 = 30
    expect(result.grossMarginCents).toBe(7970); // 8000 - 30
    expect(result.grossMarginPct).toBeCloseTo(99.625, 1);
  });

  it("excludes data outside the date range", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Old data outside range
    await seedCredits(pool, "tenant-1", "purchase", 5000, SIXTY_DAYS_AGO_ISO);
    await seedMeterEvent(pool, "tenant-1", "chat", "openai", 0.1, 0.2, SIXTY_DAYS_AGO);

    // Recent data within range
    await seedCredits(pool, "tenant-1", "purchase", 2000, NOW_ISO);

    const result = await store.getRevenueOverview(range);

    expect(result.creditsSoldCents).toBe(2000);
    expect(result.providerCostCents).toBe(0);
  });
});

describe("AnalyticsStore — getFloat", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("returns zeros for an empty database", async () => {
    const result = await store.getFloat();

    expect(result.totalFloatCents).toBe(0);
    expect(result.totalCreditsSoldCents).toBe(0);
    expect(result.floatPct).toBe(0);
    expect(result.consumedPct).toBe(100);
    expect(result.tenantCount).toBe(0);
  });

  it("calculates float correctly from credit balances", async () => {
    await seedBalance(pool, "tenant-1", 1000);
    await seedBalance(pool, "tenant-2", 500);
    await seedBalance(pool, "tenant-3", 0); // zero balance — not counted

    await seedCredits(pool, "tenant-1", "purchase", 2000, NOW_ISO);
    await seedCredits(pool, "tenant-2", "purchase", 1000, NOW_ISO);

    const result = await store.getFloat();

    expect(result.totalFloatCents).toBe(1500);
    expect(result.tenantCount).toBe(2); // only tenants with balance > 0
    expect(result.totalCreditsSoldCents).toBe(3000);
    expect(result.floatPct).toBeCloseTo(50, 1);
    expect(result.consumedPct).toBeCloseTo(50, 1);
  });
});

describe("AnalyticsStore — getRevenueBreakdown", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("returns per-use and monthly rows", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Per-use events
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.01, 0.02, NOW);
    await seedMeterEvent(pool, "t1", "image-generation", "replicate", 0.05, 0.10, NOW);

    // Monthly credit transactions
    await seedCredits(pool, "t1", "bot_runtime", -500, NOW_ISO);
    await seedCredits(pool, "t1", "addon", -200, NOW_ISO);

    const result = await store.getRevenueBreakdown(range);

    const perUse = result.filter((r) => r.category === "per_use");
    const monthly = result.filter((r) => r.category === "monthly");

    expect(perUse.length).toBeGreaterThan(0);
    expect(monthly.length).toBeGreaterThan(0);

    const chat = perUse.find((r) => r.capability === "chat");
    expect(chat).toBeDefined();
    expect(chat!.revenueCents).toBe(2); // 0.02 * 100 = 2

    const agentSeat = monthly.find((r) => r.capability === "agent_seat");
    expect(agentSeat).toBeDefined();
    expect(agentSeat!.revenueCents).toBe(500);
  });
});

describe("AnalyticsStore — getMarginByCapability", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("calculates margin per capability correctly", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // chat: charge=0.20, cost=0.10 → margin=0.10 (50%)
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.10, 0.20, NOW);
    // image-generation: charge=0.50, cost=0.25 → margin=0.25 (50%)
    await seedMeterEvent(pool, "t1", "image-generation", "replicate", 0.25, 0.50, NOW);

    const result = await store.getMarginByCapability(range);

    expect(result).toHaveLength(2);

    const chat = result.find((r) => r.capability === "chat");
    expect(chat).toBeDefined();
    expect(chat!.revenueCents).toBe(20);
    expect(chat!.costCents).toBe(10);
    expect(chat!.marginCents).toBe(10);
    expect(chat!.marginPct).toBeCloseTo(50, 1);
  });

  it("returns 0% margin for zero revenue capability (no divide-by-zero)", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // cost=0.10, charge=0.00 → revenue=0, margin should be 0%, not NaN
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.10, 0.00, NOW);

    const result = await store.getMarginByCapability(range);

    const chat = result.find((r) => r.capability === "chat");
    expect(chat).toBeDefined();
    expect(chat!.marginPct).toBe(0);
    expect(Number.isNaN(chat!.marginPct)).toBe(false);
  });
});

describe("AnalyticsStore — getProviderSpend", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("aggregates provider spend with call counts", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    await seedMeterEvent(pool, "t1", "chat", "openai", 0.01, 0.02, NOW);
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.01, 0.02, NOW);
    await seedMeterEvent(pool, "t1", "image", "replicate", 0.05, 0.10, NOW);
    await seedMeterEvent(pool, "t1", "tts", "elevenlabs", 0.02, 0.04, NOW);

    const result = await store.getProviderSpend(range);

    expect(result.length).toBe(3);

    const openai = result.find((r) => r.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.callCount).toBe(2);
    expect(openai!.spendCents).toBe(2); // 2 * 0.01 * 100 = 2
    expect(openai!.avgCostPerCallCents).toBe(1);

    const replicate = result.find((r) => r.provider === "replicate");
    expect(replicate).toBeDefined();
    expect(replicate!.callCount).toBe(1);
    expect(replicate!.spendCents).toBe(5); // 0.05 * 100 = 5
  });
});

describe("AnalyticsStore — getTenantHealth", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("counts tenants from both credit_balances and tenant_status", async () => {
    await seedBalance(pool, "tenant-a", 500);
    await seedBalance(pool, "tenant-b", 0);
    await pool.query("INSERT INTO tenant_status (tenant_id) VALUES ($1)", ["tenant-c"]);

    const result = await store.getTenantHealth();

    // tenant-a from credit_balances, tenant-b from credit_balances, tenant-c from tenant_status
    expect(result.totalTenants).toBe(3);
    expect(result.withBalance).toBe(1); // only tenant-a has balance > 0
    expect(result.atRisk).toBe(0); // TODO: placeholder
  });

  it("identifies active tenants by recent debit transactions", async () => {
    await seedBalance(pool, "tenant-a", 1000);
    await seedBalance(pool, "tenant-b", 1000);

    // tenant-a: recent activity (within 30 days)
    await seedCredits(pool, "tenant-a", "adapter_usage", -100, NOW_ISO);
    // tenant-b: old activity (older than 30 days)
    await seedCredits(pool, "tenant-b", "adapter_usage", -100, SIXTY_DAYS_AGO_ISO);

    const result = await store.getTenantHealth();

    expect(result.activeTenants).toBe(1); // only tenant-a
    expect(result.dormant).toBe(result.totalTenants - result.activeTenants);
  });
});

describe("AnalyticsStore — getTimeSeries", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("buckets data into daily periods", async () => {
    const DAY = 86_400_000;
    const now = Math.floor(Date.now() / DAY) * DAY; // align to day boundary
    const day1 = now - 2 * DAY;
    const day2 = now - 1 * DAY;
    const day3 = now;

    const day1Iso = new Date(day1 + 1000).toISOString(); // +1s to be within the bucket
    const day2Iso = new Date(day2 + 1000).toISOString();
    const day3Iso = new Date(day3 + 1000).toISOString();

    await seedMeterEvent(pool, "t1", "chat", "openai", 0.10, 0.20, day1 + 1000);
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.10, 0.20, day2 + 1000);
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.10, 0.20, day3 + 1000);

    await seedCredits(pool, "t1", "purchase", 1000, day1Iso);
    await seedCredits(pool, "t1", "purchase", 1000, day2Iso);
    await seedCredits(pool, "t1", "purchase", 1000, day3Iso);

    const range = { from: day1, to: day3 + DAY };
    const result = await store.getTimeSeries(range, DAY);

    expect(result.length).toBe(3);

    for (const point of result) {
      expect(point.creditsSoldCents).toBe(1000);
      expect(point.providerCostCents).toBe(10); // 0.10 * 100
      expect(point.revenueConsumedCents).toBe(20); // 0.20 * 100
      expect(point.marginCents).toBe(10); // 20 - 10
      expect(point.periodEnd - point.periodStart).toBe(DAY);
    }
  });

  it("auto-adjusts bucket size to stay within MAX_TIME_SERIES_POINTS", async () => {
    const HOUR = 3_600_000;
    const range = { from: 0, to: HOUR * 2000 }; // 2000 hours — would exceed 1000 pts at 1h buckets

    const result = await store.getTimeSeries(range, HOUR);

    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it("creates credit-only periods when there are no meter events for that bucket", async () => {
    const DAY = 86_400_000;
    const now = Math.floor(Date.now() / DAY) * DAY;
    const day1 = now - 2 * DAY;
    const day2 = now - 1 * DAY;

    // day1: meter event only (no credit transaction)
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.10, 0.20, day1 + 1000);

    // day2: credit transaction only (no meter event) — exercises the else branch in getTimeSeries
    const day2Iso = new Date(day2 + 1000).toISOString();
    await seedCredits(pool, "t1", "purchase", 500, day2Iso);
    await seedCredits(pool, "t1", "bot_runtime", -100, day2Iso);

    const range = { from: day1, to: day2 + DAY };
    const result = await store.getTimeSeries(range, DAY);

    expect(result.length).toBe(2);

    const meterOnlyPoint = result.find((p) => p.periodStart === day1);
    expect(meterOnlyPoint).toBeDefined();
    expect(meterOnlyPoint!.creditsSoldCents).toBe(0);
    expect(meterOnlyPoint!.revenueConsumedCents).toBe(20);
    expect(meterOnlyPoint!.providerCostCents).toBe(10);

    const creditOnlyPoint = result.find((p) => p.periodStart === day2);
    expect(creditOnlyPoint).toBeDefined();
    expect(creditOnlyPoint!.creditsSoldCents).toBe(500);
    expect(creditOnlyPoint!.revenueConsumedCents).toBe(100); // bot_runtime ABS
    expect(creditOnlyPoint!.providerCostCents).toBe(0);
    expect(creditOnlyPoint!.marginCents).toBe(100);
  });
});

describe("AnalyticsStore — exportCsv", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  const range = { from: THIRTY_DAYS_AGO, to: NOW };

  it("exports revenue_overview as CSV with correct headers", async () => {
    const csv = await store.exportCsv(range, "revenue_overview");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("creditsSoldCents");
    expect(lines[0]).toContain("grossMarginPct");
    expect(lines.length).toBe(2); // header + 1 data row
  });

  it("exports revenue_breakdown as CSV", async () => {
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.01, 0.02, NOW);
    const csv = await store.exportCsv(range, "revenue_breakdown");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("category");
    expect(lines[0]).toContain("capability");
    expect(lines[0]).toContain("revenueCents");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("exports margin_by_capability as CSV", async () => {
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.01, 0.02, NOW);
    const csv = await store.exportCsv(range, "margin_by_capability");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("capability");
    expect(lines[0]).toContain("marginPct");
  });

  it("exports provider_spend as CSV", async () => {
    await seedMeterEvent(pool, "t1", "chat", "openai", 0.01, 0.02, NOW);
    const csv = await store.exportCsv(range, "provider_spend");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("provider");
    expect(lines[0]).toContain("callCount");
  });

  it("exports tenant_health as CSV", async () => {
    const csv = await store.exportCsv(range, "tenant_health");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("totalTenants");
    expect(lines.length).toBe(2);
  });

  it("exports time_series as CSV", async () => {
    const csv = await store.exportCsv(range, "time_series");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("periodStart");
    expect(lines[0]).toContain("marginCents");
  });

  it("escapes values containing commas in CSV output", async () => {
    await pool.query(
      "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [crypto.randomUUID(), "t1", 0.01, 0.02, "chat,text", "openai", NOW],
    );

    const csv = await store.exportCsv(range, "margin_by_capability");

    // The capability "chat,text" should be quoted in CSV
    expect(csv).toContain('"chat,text"');
  });

  it("escapes values containing double-quotes in CSV output", async () => {
    await pool.query(
      "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [crypto.randomUUID(), "t1", 0.01, 0.02, 'chat"premium"', "openai", NOW],
    );

    const csv = await store.exportCsv(range, "margin_by_capability");

    // Double-quotes inside a quoted field must be escaped as ""
    expect(csv).toContain('"chat""premium"""');
  });

  it("returns empty string for unknown export section", async () => {
    const csv = await store.exportCsv(range, "nonexistent_section");

    expect(csv).toBe("");
  });

  it("exports auto_topup as CSV with correct headers", async () => {
    await seedAutoTopup(pool, "tenant-1", 5000, "success", NOW_ISO);
    const csv = await store.exportCsv(range, "auto_topup");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("totalEvents");
    expect(lines[0]).toContain("revenueCents");
    expect(lines[0]).toContain("failureRate");
    expect(lines.length).toBe(2); // header + 1 data row
  });
});

describe("AnalyticsStore — getAutoTopupMetrics", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("returns all zeros for an empty database", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };
    const result = await store.getAutoTopupMetrics(range);

    expect(result.totalEvents).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.revenueCents).toBe(0);
    expect(result.failureRate).toBe(0);
  });

  it("calculates success/failure counts and revenue correctly", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    await seedAutoTopup(pool, "tenant-1", 5000, "success", NOW_ISO);
    await seedAutoTopup(pool, "tenant-1", 5000, "success", NOW_ISO);
    await seedAutoTopup(pool, "tenant-2", 3000, "success", NOW_ISO);
    await seedAutoTopup(pool, "tenant-3", 5000, "failed", NOW_ISO, "card_declined");

    const result = await store.getAutoTopupMetrics(range);

    expect(result.totalEvents).toBe(4);
    expect(result.successCount).toBe(3);
    expect(result.failedCount).toBe(1);
    expect(result.revenueCents).toBe(13000); // 5000 + 5000 + 3000
    expect(result.failureRate).toBeCloseTo(25, 1); // 1/4 = 25%
  });

  it("excludes data outside the date range", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Old data outside range
    await seedAutoTopup(pool, "tenant-1", 5000, "success", SIXTY_DAYS_AGO_ISO);
    // Recent data within range
    await seedAutoTopup(pool, "tenant-1", 3000, "success", NOW_ISO);

    const result = await store.getAutoTopupMetrics(range);

    expect(result.totalEvents).toBe(1);
    expect(result.revenueCents).toBe(3000);
  });

  it("returns 0% failure rate when all events are successes", async () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    await seedAutoTopup(pool, "tenant-1", 5000, "success", NOW_ISO);
    await seedAutoTopup(pool, "tenant-2", 3000, "success", NOW_ISO);

    const result = await store.getAutoTopupMetrics(range);

    expect(result.failureRate).toBe(0);
  });
});

describe("AnalyticsStore — getTenantHealth (atRisk with auto-topup)", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  it("counts tenants with low balance and no auto-topup as at-risk", async () => {
    // tenant-a: low balance, NO auto-topup history -> at risk
    await seedBalance(pool, "tenant-a", 200);
    // tenant-b: low balance, HAS auto-topup history -> NOT at risk
    await seedBalance(pool, "tenant-b", 200);
    await seedAutoTopup(pool, "tenant-b", 5000, "success", NOW_ISO);
    // tenant-c: high balance, no auto-topup -> NOT at risk
    await seedBalance(pool, "tenant-c", 10000);

    const result = await store.getTenantHealth();

    expect(result.atRisk).toBe(1); // only tenant-a
  });

  it("returns 0 at-risk when all low-balance tenants have auto-topup", async () => {
    await seedBalance(pool, "tenant-a", 200);
    await seedAutoTopup(pool, "tenant-a", 5000, "success", NOW_ISO);

    const result = await store.getTenantHealth();

    expect(result.atRisk).toBe(0);
  });

  it("returns 0 at-risk when no tenants have low balance", async () => {
    await seedBalance(pool, "tenant-a", 10000);
    await seedBalance(pool, "tenant-b", 5000);

    const result = await store.getTenantHealth();

    expect(result.atRisk).toBe(0);
  });
});
