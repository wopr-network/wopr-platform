import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, seedMeterEvent, truncateAllTables } from "../../test/db.js";
import { AnalyticsStore, type DateRange } from "./analytics-store.js";

describe("AnalyticsStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  // Pin time to a stable anchor so that the RANGE and all seed timestamps are consistent.
  const ANCHOR = new Date("2026-03-01T12:00:00Z");

  // A 31-day window ending at ANCHOR
  const RANGE: DateRange = {
    from: ANCHOR.getTime() - 31 * 24 * 60 * 60 * 1000,
    to: ANCHOR.getTime(),
  };

  // A timestamp 15 days before ANCHOR — well within RANGE
  const MID_TS = ANCHOR.getTime() - 15 * 24 * 60 * 60 * 1000;

  // A timestamp well outside RANGE (1 year before ANCHOR)
  const OUT_OF_RANGE_TS = ANCHOR.getTime() - 365 * 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    await truncateAllTables(pool);
    store = new AnalyticsStore(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getRevenueOverview", () => {
    it("returns zeros when no data exists", async () => {
      const overview = await store.getRevenueOverview(RANGE);
      expect(overview.creditsSoldCents).toBe(0);
      expect(overview.revenueConsumedCents).toBe(0);
      expect(overview.providerCostCents).toBe(0);
      expect(overview.grossMarginCents).toBe(0);
      expect(overview.grossMarginPct).toBe(0);
    });

    it("calculates provider cost from meter_events", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 0.5,
        cost: 0.25,
        timestamp: MID_TS,
      });

      const overview = await store.getRevenueOverview(RANGE);
      expect(overview.providerCostCents).toBe(25); // 0.25 * 100
    });

    it("excludes events outside range", async () => {
      await seedMeterEvent(db, {
        id: "me-out",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.5,
        timestamp: OUT_OF_RANGE_TS,
      });

      const overview = await store.getRevenueOverview(RANGE);
      expect(overview.providerCostCents).toBe(0);
    });
  });

  describe("getFloat", () => {
    it("returns zeros when no balances exist", async () => {
      const f = await store.getFloat();
      expect(f.totalFloatCents).toBe(0);
      expect(f.totalCreditsSoldCents).toBe(0);
      expect(f.tenantCount).toBe(0);
      expect(f.floatPct).toBe(0);
      expect(f.consumedPct).toBe(100);
    });
  });

  describe("getMarginByCapability", () => {
    it("returns empty array when no meter events exist", async () => {
      const result = await store.getMarginByCapability(RANGE);
      expect(result).toEqual([]);
    });

    it("calculates margin per capability", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.3,
        timestamp: MID_TS,
        capability: "llm",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 0.5,
        cost: 0.1,
        timestamp: MID_TS,
        capability: "llm",
      });

      const result = await store.getMarginByCapability(RANGE);
      expect(result).toHaveLength(1);
      expect(result[0].capability).toBe("llm");
      expect(result[0].revenueCents).toBe(150); // (1.0 + 0.5) * 100
      expect(result[0].costCents).toBe(40); // (0.3 + 0.1) * 100
      expect(result[0].marginCents).toBe(110);
    });

    it("groups by capability", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.5,
        timestamp: MID_TS,
        capability: "llm",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 0.5,
        cost: 0.1,
        timestamp: MID_TS,
        capability: "tts",
      });

      const result = await store.getMarginByCapability(RANGE);
      expect(result).toHaveLength(2);
      const caps = result.map((r) => r.capability).sort();
      expect(caps).toEqual(["llm", "tts"]);
    });
  });

  describe("getProviderSpend", () => {
    it("returns empty array when no meter events exist", async () => {
      const result = await store.getProviderSpend(RANGE);
      expect(result).toEqual([]);
    });

    it("aggregates spend per provider", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.5,
        timestamp: MID_TS,
        provider: "openai",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 0.8,
        cost: 0.3,
        timestamp: MID_TS,
        provider: "openai",
      });

      const result = await store.getProviderSpend(RANGE);
      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe("openai");
      expect(result[0].callCount).toBe(2);
      expect(result[0].spendCents).toBe(80); // (0.5 + 0.3) * 100
    });

    it("calculates avgCostPerCallCents", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.4,
        timestamp: MID_TS,
        provider: "anthropic",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.6,
        timestamp: MID_TS,
        provider: "anthropic",
      });

      const result = await store.getProviderSpend(RANGE);
      expect(result[0].avgCostPerCallCents).toBe(50); // (0.4 + 0.6) * 100 / 2
    });
  });

  describe("getTimeSeries", () => {
    it("returns empty array when no data exists", async () => {
      const result = await store.getTimeSeries(RANGE, 86_400_000);
      expect(result).toEqual([]);
    });

    it("auto-adjusts bucket size to cap at 1000 points", async () => {
      // Range is 31 days (very small bucket of 1ms would be millions of points)
      const result = await store.getTimeSeries(RANGE, 1);
      expect(result.length).toBeLessThanOrEqual(1000);
    });

    it("buckets meter events by time period", async () => {
      const day1 = ANCHOR.getTime() - 20 * 24 * 60 * 60 * 1000;
      const day2 = ANCHOR.getTime() - 19 * 24 * 60 * 60 * 1000;
      await seedMeterEvent(db, { id: "me-1", tenant: "t-1", charge: 1.0, cost: 0.5, timestamp: day1 });
      await seedMeterEvent(db, { id: "me-2", tenant: "t-1", charge: 2.0, cost: 1.0, timestamp: day2 });

      const result = await store.getTimeSeries(RANGE, 86_400_000);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // Events on different days should be in different buckets
      const periodStarts = result.map((r) => r.periodStart);
      expect(new Set(periodStarts).size).toBe(result.length); // no duplicate periods
    });
  });

  describe("exportCsv", () => {
    it("returns CSV header for revenue_overview with no data", async () => {
      const csv = await store.exportCsv(RANGE, "revenue_overview");
      expect(csv).toContain("creditsSoldCents");
      expect(csv).toContain("revenueConsumedCents");
      expect(csv).toContain("providerCostCents");
      expect(csv.split("\n")).toHaveLength(2); // header + 1 data row
    });

    it("returns empty string for unknown section", async () => {
      const csv = await store.exportCsv(RANGE, "nonexistent");
      expect(csv).toBe("");
    });

    it("exports provider_spend section", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1,
        cost: 0.5,
        timestamp: MID_TS,
        provider: "openai",
      });

      const csv = await store.exportCsv(RANGE, "provider_spend");
      expect(csv).toContain("provider");
      expect(csv).toContain("openai");
    });

    it("exports margin_by_capability section", async () => {
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1,
        cost: 0.5,
        timestamp: MID_TS,
        capability: "llm",
      });

      const csv = await store.exportCsv(RANGE, "margin_by_capability");
      expect(csv).toContain("capability");
      expect(csv).toContain("llm");
    });

    it("exports tenant_health section", async () => {
      const csv = await store.exportCsv(RANGE, "tenant_health");
      expect(csv).toContain("totalTenants");
    });
  });

  describe("getTenantHealth", () => {
    it("returns zeros when no data exists", async () => {
      const health = await store.getTenantHealth();
      expect(health.totalTenants).toBe(0);
      expect(health.activeTenants).toBe(0);
      expect(health.withBalance).toBe(0);
      expect(health.dormant).toBe(0);
      expect(health.atRisk).toBe(0);
    });
  });

  describe("getAutoTopupMetrics", () => {
    it("returns zeros when no data exists", async () => {
      const metrics = await store.getAutoTopupMetrics(RANGE);
      expect(metrics.totalEvents).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.failedCount).toBe(0);
      expect(metrics.revenueCents).toBe(0);
      expect(metrics.failureRate).toBe(0);
    });
  });
});
