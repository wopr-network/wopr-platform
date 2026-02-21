import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsStore } from "../../../src/admin/analytics/analytics-store.js";
import { initCreditSchema } from "../../../src/monetization/credits/schema.js";
import { initMeterSchema } from "../../../src/monetization/metering/schema.js";

type TestDb = BetterSqlite3.Database;

function initTenantStatusSchema(db: TestDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_status (
      tenant_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      status_changed_at INTEGER,
      status_changed_by TEXT,
      grace_deadline TEXT,
      data_delete_after TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

function initAutoTopupSchema(db: TestDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_auto_topup (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      payment_reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_auto_topup_tenant ON credit_auto_topup(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_auto_topup_status ON credit_auto_topup(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_auto_topup_created ON credit_auto_topup(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_auto_topup_tenant_created ON credit_auto_topup(tenant_id, created_at)");
}

function seedAutoTopup(
  db: TestDb,
  tenantId: string,
  amountCents: number,
  status: "success" | "failed",
  createdAt: string,
  failureReason?: string,
): void {
  db.prepare(
    "INSERT INTO credit_auto_topup (id, tenant_id, amount_cents, status, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(crypto.randomUUID(), tenantId, amountCents, status, failureReason ?? null, createdAt);
}

function createTestDb(): TestDb {
  const db = new BetterSqlite3(":memory:");
  initCreditSchema(db);
  initMeterSchema(db);
  initTenantStatusSchema(db);
  initAutoTopupSchema(db);
  return db;
}

function seedCredits(
  db: TestDb,
  tenantId: string,
  type: string,
  amountCents: number,
  createdAt: string,
): void {
  db.prepare(
    "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(crypto.randomUUID(), tenantId, amountCents, 0, type, createdAt);
}

function seedMeterEvent(
  db: TestDb,
  tenant: string,
  capability: string,
  provider: string,
  cost: number,
  charge: number,
  timestamp: number,
): void {
  db.prepare(
    "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(crypto.randomUUID(), tenant, cost, charge, capability, provider, timestamp);
}

function seedBalance(db: TestDb, tenantId: string, balanceCents: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO credit_balances (tenant_id, balance_cents, last_updated) VALUES (?, ?, datetime('now'))",
  ).run(tenantId, balanceCents);
}

const NOW = Date.now();
const THIRTY_DAYS_AGO = NOW - 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_AGO = NOW - 60 * 24 * 60 * 60 * 1000;

const NOW_ISO = new Date(NOW).toISOString();
const THIRTY_DAYS_AGO_ISO = new Date(THIRTY_DAYS_AGO).toISOString();
const SIXTY_DAYS_AGO_ISO = new Date(SIXTY_DAYS_AGO).toISOString();

describe("AnalyticsStore — getRevenueOverview", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns all zeros for an empty database", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };
    const result = store.getRevenueOverview(range);

    expect(result.creditsSoldCents).toBe(0);
    expect(result.revenueConsumedCents).toBe(0);
    expect(result.providerCostCents).toBe(0);
    expect(result.grossMarginCents).toBe(0);
    expect(result.grossMarginPct).toBe(0);
  });

  it("calculates revenue, cost, and margin correctly", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Purchase: $100 in credits
    seedCredits(db, "tenant-1", "purchase", 10000, NOW_ISO);
    // Consumed: $60 adapter_usage + $20 bot_runtime = $80
    seedCredits(db, "tenant-1", "adapter_usage", -6000, NOW_ISO);
    seedCredits(db, "tenant-1", "bot_runtime", -2000, NOW_ISO);
    // Provider cost: $30 → 3000 cents
    seedMeterEvent(db, "tenant-1", "chat", "openai", 0.3, 0.6, NOW);

    const result = store.getRevenueOverview(range);

    expect(result.creditsSoldCents).toBe(10000);
    expect(result.revenueConsumedCents).toBe(8000);
    expect(result.providerCostCents).toBe(30); // 0.3 * 100 = 30
    expect(result.grossMarginCents).toBe(7970); // 8000 - 30
    expect(result.grossMarginPct).toBeCloseTo(99.625, 1);
  });

  it("excludes data outside the date range", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Old data outside range
    seedCredits(db, "tenant-1", "purchase", 5000, SIXTY_DAYS_AGO_ISO);
    seedMeterEvent(db, "tenant-1", "chat", "openai", 0.1, 0.2, SIXTY_DAYS_AGO);

    // Recent data within range
    seedCredits(db, "tenant-1", "purchase", 2000, NOW_ISO);

    const result = store.getRevenueOverview(range);

    expect(result.creditsSoldCents).toBe(2000);
    expect(result.providerCostCents).toBe(0);
  });
});

describe("AnalyticsStore — getFloat", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns zeros for an empty database", () => {
    const result = store.getFloat();

    expect(result.totalFloatCents).toBe(0);
    expect(result.totalCreditsSoldCents).toBe(0);
    expect(result.floatPct).toBe(0);
    expect(result.consumedPct).toBe(100);
    expect(result.tenantCount).toBe(0);
  });

  it("calculates float correctly from credit balances", () => {
    seedBalance(db, "tenant-1", 1000);
    seedBalance(db, "tenant-2", 500);
    seedBalance(db, "tenant-3", 0); // zero balance — not counted

    seedCredits(db, "tenant-1", "purchase", 2000, NOW_ISO);
    seedCredits(db, "tenant-2", "purchase", 1000, NOW_ISO);

    const result = store.getFloat();

    expect(result.totalFloatCents).toBe(1500);
    expect(result.tenantCount).toBe(2); // only tenants with balance > 0
    expect(result.totalCreditsSoldCents).toBe(3000);
    expect(result.floatPct).toBeCloseTo(50, 1);
    expect(result.consumedPct).toBeCloseTo(50, 1);
  });
});

describe("AnalyticsStore — getRevenueBreakdown", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns per-use and monthly rows", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Per-use events
    seedMeterEvent(db, "t1", "chat", "openai", 0.01, 0.02, NOW);
    seedMeterEvent(db, "t1", "image-generation", "replicate", 0.05, 0.10, NOW);

    // Monthly credit transactions
    seedCredits(db, "t1", "bot_runtime", -500, NOW_ISO);
    seedCredits(db, "t1", "addon", -200, NOW_ISO);

    const result = store.getRevenueBreakdown(range);

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
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("calculates margin per capability correctly", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // chat: charge=0.20, cost=0.10 → margin=0.10 (50%)
    seedMeterEvent(db, "t1", "chat", "openai", 0.10, 0.20, NOW);
    // image-generation: charge=0.50, cost=0.25 → margin=0.25 (50%)
    seedMeterEvent(db, "t1", "image-generation", "replicate", 0.25, 0.50, NOW);

    const result = store.getMarginByCapability(range);

    expect(result).toHaveLength(2);

    const chat = result.find((r) => r.capability === "chat");
    expect(chat).toBeDefined();
    expect(chat!.revenueCents).toBe(20);
    expect(chat!.costCents).toBe(10);
    expect(chat!.marginCents).toBe(10);
    expect(chat!.marginPct).toBeCloseTo(50, 1);
  });

  it("returns 0% margin for zero revenue capability (no divide-by-zero)", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // cost=0.10, charge=0.00 → revenue=0, margin should be 0%, not NaN
    seedMeterEvent(db, "t1", "chat", "openai", 0.10, 0.00, NOW);

    const result = store.getMarginByCapability(range);

    const chat = result.find((r) => r.capability === "chat");
    expect(chat).toBeDefined();
    expect(chat!.marginPct).toBe(0);
    expect(Number.isNaN(chat!.marginPct)).toBe(false);
  });
});

describe("AnalyticsStore — getProviderSpend", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("aggregates provider spend with call counts", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    seedMeterEvent(db, "t1", "chat", "openai", 0.01, 0.02, NOW);
    seedMeterEvent(db, "t1", "chat", "openai", 0.01, 0.02, NOW);
    seedMeterEvent(db, "t1", "image", "replicate", 0.05, 0.10, NOW);
    seedMeterEvent(db, "t1", "tts", "elevenlabs", 0.02, 0.04, NOW);

    const result = store.getProviderSpend(range);

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
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("counts tenants from both credit_balances and tenant_status", () => {
    seedBalance(db, "tenant-a", 500);
    seedBalance(db, "tenant-b", 0);
    db.prepare("INSERT INTO tenant_status (tenant_id) VALUES (?)").run("tenant-c");

    const result = store.getTenantHealth();

    // tenant-a from credit_balances, tenant-b from credit_balances, tenant-c from tenant_status
    expect(result.totalTenants).toBe(3);
    expect(result.withBalance).toBe(1); // only tenant-a has balance > 0
    expect(result.atRisk).toBe(0); // TODO: placeholder
  });

  it("identifies active tenants by recent debit transactions", () => {
    seedBalance(db, "tenant-a", 1000);
    seedBalance(db, "tenant-b", 1000);

    // tenant-a: recent activity (within 30 days)
    seedCredits(db, "tenant-a", "adapter_usage", -100, NOW_ISO);
    // tenant-b: old activity (older than 30 days)
    seedCredits(db, "tenant-b", "adapter_usage", -100, SIXTY_DAYS_AGO_ISO);

    const result = store.getTenantHealth();

    expect(result.activeTenants).toBe(1); // only tenant-a
    expect(result.dormant).toBe(result.totalTenants - result.activeTenants);
  });
});

describe("AnalyticsStore — getTimeSeries", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("buckets data into daily periods", () => {
    const DAY = 86_400_000;
    const now = Math.floor(Date.now() / DAY) * DAY; // align to day boundary
    const day1 = now - 2 * DAY;
    const day2 = now - 1 * DAY;
    const day3 = now;

    const day1Iso = new Date(day1 + 1000).toISOString(); // +1s to be within the bucket
    const day2Iso = new Date(day2 + 1000).toISOString();
    const day3Iso = new Date(day3 + 1000).toISOString();

    seedMeterEvent(db, "t1", "chat", "openai", 0.10, 0.20, day1 + 1000);
    seedMeterEvent(db, "t1", "chat", "openai", 0.10, 0.20, day2 + 1000);
    seedMeterEvent(db, "t1", "chat", "openai", 0.10, 0.20, day3 + 1000);

    seedCredits(db, "t1", "purchase", 1000, day1Iso);
    seedCredits(db, "t1", "purchase", 1000, day2Iso);
    seedCredits(db, "t1", "purchase", 1000, day3Iso);

    const range = { from: day1, to: day3 + DAY };
    const result = store.getTimeSeries(range, DAY);

    expect(result.length).toBe(3);

    for (const point of result) {
      expect(point.creditsSoldCents).toBe(1000);
      expect(point.providerCostCents).toBe(10); // 0.10 * 100
      expect(point.revenueConsumedCents).toBe(20); // 0.20 * 100
      expect(point.marginCents).toBe(10); // 20 - 10
      expect(point.periodEnd - point.periodStart).toBe(DAY);
    }
  });

  it("auto-adjusts bucket size to stay within MAX_TIME_SERIES_POINTS", () => {
    const HOUR = 3_600_000;
    const range = { from: 0, to: HOUR * 2000 }; // 2000 hours — would exceed 1000 pts at 1h buckets

    const result = store.getTimeSeries(range, HOUR);

    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it("creates credit-only periods when there are no meter events for that bucket", () => {
    const DAY = 86_400_000;
    const now = Math.floor(Date.now() / DAY) * DAY;
    const day1 = now - 2 * DAY;
    const day2 = now - 1 * DAY;

    // day1: meter event only (no credit transaction)
    seedMeterEvent(db, "t1", "chat", "openai", 0.10, 0.20, day1 + 1000);

    // day2: credit transaction only (no meter event) — exercises the else branch in getTimeSeries
    const day2Iso = new Date(day2 + 1000).toISOString();
    seedCredits(db, "t1", "purchase", 500, day2Iso);
    seedCredits(db, "t1", "bot_runtime", -100, day2Iso);

    const range = { from: day1, to: day2 + DAY };
    const result = store.getTimeSeries(range, DAY);

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
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  const range = { from: THIRTY_DAYS_AGO, to: NOW };

  it("exports revenue_overview as CSV with correct headers", () => {
    const csv = store.exportCsv(range, "revenue_overview");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("creditsSoldCents");
    expect(lines[0]).toContain("grossMarginPct");
    expect(lines.length).toBe(2); // header + 1 data row
  });

  it("exports revenue_breakdown as CSV", () => {
    seedMeterEvent(db, "t1", "chat", "openai", 0.01, 0.02, NOW);
    const csv = store.exportCsv(range, "revenue_breakdown");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("category");
    expect(lines[0]).toContain("capability");
    expect(lines[0]).toContain("revenueCents");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("exports margin_by_capability as CSV", () => {
    seedMeterEvent(db, "t1", "chat", "openai", 0.01, 0.02, NOW);
    const csv = store.exportCsv(range, "margin_by_capability");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("capability");
    expect(lines[0]).toContain("marginPct");
  });

  it("exports provider_spend as CSV", () => {
    seedMeterEvent(db, "t1", "chat", "openai", 0.01, 0.02, NOW);
    const csv = store.exportCsv(range, "provider_spend");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("provider");
    expect(lines[0]).toContain("callCount");
  });

  it("exports tenant_health as CSV", () => {
    const csv = store.exportCsv(range, "tenant_health");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("totalTenants");
    expect(lines.length).toBe(2);
  });

  it("exports time_series as CSV", () => {
    const csv = store.exportCsv(range, "time_series");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("periodStart");
    expect(lines[0]).toContain("marginCents");
  });

  it("escapes values containing commas in CSV output", () => {
    // We can test this with a capability name containing a comma (unlikely in real data,
    // but the toCsv helper should handle it)
    db.prepare(
      "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), "t1", 0.01, 0.02, "chat,text", "openai", NOW);

    const csv = store.exportCsv(range, "margin_by_capability");

    // The capability "chat,text" should be quoted in CSV
    expect(csv).toContain('"chat,text"');
  });

  it("escapes values containing double-quotes in CSV output", () => {
    db.prepare(
      "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), "t1", 0.01, 0.02, 'chat"premium"', "openai", NOW);

    const csv = store.exportCsv(range, "margin_by_capability");

    // Double-quotes inside a quoted field must be escaped as ""
    expect(csv).toContain('"chat""premium"""');
  });

  it("returns empty string for unknown export section", () => {
    const csv = store.exportCsv(range, "nonexistent_section");

    expect(csv).toBe("");
  });

  it("exports auto_topup as CSV with correct headers", () => {
    seedAutoTopup(db, "tenant-1", 5000, "success", NOW_ISO);
    const csv = store.exportCsv(range, "auto_topup");
    const lines = csv.split("\n");

    expect(lines[0]).toContain("totalEvents");
    expect(lines[0]).toContain("revenueCents");
    expect(lines[0]).toContain("failureRate");
    expect(lines.length).toBe(2); // header + 1 data row
  });
});

describe("AnalyticsStore — getAutoTopupMetrics", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns all zeros for an empty database", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };
    const result = store.getAutoTopupMetrics(range);

    expect(result.totalEvents).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.revenueCents).toBe(0);
    expect(result.failureRate).toBe(0);
  });

  it("calculates success/failure counts and revenue correctly", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    seedAutoTopup(db, "tenant-1", 5000, "success", NOW_ISO);
    seedAutoTopup(db, "tenant-1", 5000, "success", NOW_ISO);
    seedAutoTopup(db, "tenant-2", 3000, "success", NOW_ISO);
    seedAutoTopup(db, "tenant-3", 5000, "failed", NOW_ISO, "card_declined");

    const result = store.getAutoTopupMetrics(range);

    expect(result.totalEvents).toBe(4);
    expect(result.successCount).toBe(3);
    expect(result.failedCount).toBe(1);
    expect(result.revenueCents).toBe(13000); // 5000 + 5000 + 3000
    expect(result.failureRate).toBeCloseTo(25, 1); // 1/4 = 25%
  });

  it("excludes data outside the date range", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    // Old data outside range
    seedAutoTopup(db, "tenant-1", 5000, "success", SIXTY_DAYS_AGO_ISO);
    // Recent data within range
    seedAutoTopup(db, "tenant-1", 3000, "success", NOW_ISO);

    const result = store.getAutoTopupMetrics(range);

    expect(result.totalEvents).toBe(1);
    expect(result.revenueCents).toBe(3000);
  });

  it("returns 0% failure rate when all events are successes", () => {
    const range = { from: THIRTY_DAYS_AGO, to: NOW };

    seedAutoTopup(db, "tenant-1", 5000, "success", NOW_ISO);
    seedAutoTopup(db, "tenant-2", 3000, "success", NOW_ISO);

    const result = store.getAutoTopupMetrics(range);

    expect(result.failureRate).toBe(0);
  });
});

describe("AnalyticsStore — getTenantHealth (atRisk with auto-topup)", () => {
  let db: TestDb;
  let store: AnalyticsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("counts tenants with low balance and no auto-topup as at-risk", () => {
    // tenant-a: low balance, NO auto-topup history -> at risk
    seedBalance(db, "tenant-a", 200);
    // tenant-b: low balance, HAS auto-topup history -> NOT at risk
    seedBalance(db, "tenant-b", 200);
    seedAutoTopup(db, "tenant-b", 5000, "success", NOW_ISO);
    // tenant-c: high balance, no auto-topup -> NOT at risk
    seedBalance(db, "tenant-c", 10000);

    const result = store.getTenantHealth();

    expect(result.atRisk).toBe(1); // only tenant-a
  });

  it("returns 0 at-risk when all low-balance tenants have auto-topup", () => {
    seedBalance(db, "tenant-a", 200);
    seedAutoTopup(db, "tenant-a", 5000, "success", NOW_ISO);

    const result = store.getTenantHealth();

    expect(result.atRisk).toBe(0);
  });

  it("returns 0 at-risk when no tenants have low balance", () => {
    seedBalance(db, "tenant-a", 10000);
    seedBalance(db, "tenant-b", 5000);

    const result = store.getTenantHealth();

    expect(result.atRisk).toBe(0);
  });
});
