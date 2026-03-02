import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, seedMeterEvent, truncateAllTables } from "../../test/db.js";
import { AnalyticsStore, type DateRange } from "./analytics-store.js";

describe("AnalyticsStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AnalyticsStore;

  const JAN_2026: DateRange = {
    from: new Date("2026-01-01T00:00:00Z").getTime(),
    to: new Date("2026-02-01T00:00:00Z").getTime(),
  };

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

  describe("getRevenueOverview", () => {
    it("returns zeros when no data exists", async () => {
      const overview = await store.getRevenueOverview(JAN_2026);
      expect(overview.creditsSoldCents).toBe(0);
      expect(overview.revenueConsumedCents).toBe(0);
      expect(overview.providerCostCents).toBe(0);
      expect(overview.grossMarginCents).toBe(0);
      expect(overview.grossMarginPct).toBe(0);
    });

    it("calculates provider cost from meter_events", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 0.5,
        cost: 0.25,
        timestamp: ts,
      });

      const overview = await store.getRevenueOverview(JAN_2026);
      expect(overview.providerCostCents).toBe(25); // 0.25 * 100
    });

    it("excludes events outside range", async () => {
      const ts = new Date("2025-06-01T00:00:00Z").getTime();
      await seedMeterEvent(db, {
        id: "me-out",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.5,
        timestamp: ts,
      });

      const overview = await store.getRevenueOverview(JAN_2026);
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
      const result = await store.getMarginByCapability(JAN_2026);
      expect(result).toEqual([]);
    });

    it("calculates margin per capability", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.3,
        timestamp: ts,
        capability: "llm",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 0.5,
        cost: 0.1,
        timestamp: ts,
        capability: "llm",
      });

      const result = await store.getMarginByCapability(JAN_2026);
      expect(result).toHaveLength(1);
      expect(result[0].capability).toBe("llm");
      expect(result[0].revenueCents).toBe(150); // (1.0 + 0.5) * 100
      expect(result[0].costCents).toBe(40); // (0.3 + 0.1) * 100
      expect(result[0].marginCents).toBe(110);
    });

    it("groups by capability", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, { id: "me-1", tenant: "t-1", charge: 1.0, cost: 0.5, timestamp: ts, capability: "llm" });
      await seedMeterEvent(db, { id: "me-2", tenant: "t-1", charge: 0.5, cost: 0.1, timestamp: ts, capability: "tts" });

      const result = await store.getMarginByCapability(JAN_2026);
      expect(result).toHaveLength(2);
      const caps = result.map((r) => r.capability).sort();
      expect(caps).toEqual(["llm", "tts"]);
    });
  });

  describe("getProviderSpend", () => {
    it("returns empty array when no meter events exist", async () => {
      const result = await store.getProviderSpend(JAN_2026);
      expect(result).toEqual([]);
    });

    it("aggregates spend per provider", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.5,
        timestamp: ts,
        provider: "openai",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 0.8,
        cost: 0.3,
        timestamp: ts,
        provider: "openai",
      });

      const result = await store.getProviderSpend(JAN_2026);
      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe("openai");
      expect(result[0].callCount).toBe(2);
      expect(result[0].spendCents).toBe(80); // (0.5 + 0.3) * 100
    });

    it("calculates avgCostPerCallCents", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, {
        id: "me-1",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.4,
        timestamp: ts,
        provider: "anthropic",
      });
      await seedMeterEvent(db, {
        id: "me-2",
        tenant: "t-1",
        charge: 1.0,
        cost: 0.6,
        timestamp: ts,
        provider: "anthropic",
      });

      const result = await store.getProviderSpend(JAN_2026);
      expect(result[0].avgCostPerCallCents).toBe(50); // (0.4 + 0.6) * 100 / 2
    });
  });

  describe("getTimeSeries", () => {
    it("returns empty array when no data exists", async () => {
      const result = await store.getTimeSeries(JAN_2026, 86_400_000);
      expect(result).toEqual([]);
    });

    it("auto-adjusts bucket size to cap at 1000 points", async () => {
      // Range is 31 days (very small bucket of 1ms would be millions of points)
      const result = await store.getTimeSeries(JAN_2026, 1);
      expect(result.length).toBeLessThanOrEqual(1000);
    });

    it("buckets meter events by time period", async () => {
      const day1 = new Date("2026-01-01T12:00:00Z").getTime();
      const day2 = new Date("2026-01-02T12:00:00Z").getTime();
      await seedMeterEvent(db, { id: "me-1", tenant: "t-1", charge: 1.0, cost: 0.5, timestamp: day1 });
      await seedMeterEvent(db, { id: "me-2", tenant: "t-1", charge: 2.0, cost: 1.0, timestamp: day2 });

      const result = await store.getTimeSeries(JAN_2026, 86_400_000);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // Events on different days should be in different buckets
      const periodStarts = result.map((r) => r.periodStart);
      expect(new Set(periodStarts).size).toBe(result.length); // no duplicate periods
    });
  });

  describe("exportCsv", () => {
    it("returns CSV header for revenue_overview with no data", async () => {
      const csv = await store.exportCsv(JAN_2026, "revenue_overview");
      expect(csv).toContain("creditsSoldCents");
      expect(csv).toContain("revenueConsumedCents");
      expect(csv).toContain("providerCostCents");
      expect(csv.split("\n")).toHaveLength(2); // header + 1 data row
    });

    it("returns empty string for unknown section", async () => {
      const csv = await store.exportCsv(JAN_2026, "nonexistent");
      expect(csv).toBe("");
    });

    it("exports provider_spend section", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, { id: "me-1", tenant: "t-1", charge: 1, cost: 0.5, timestamp: ts, provider: "openai" });

      const csv = await store.exportCsv(JAN_2026, "provider_spend");
      expect(csv).toContain("provider");
      expect(csv).toContain("openai");
    });

    it("exports margin_by_capability section", async () => {
      const ts = new Date("2026-01-15T00:00:00Z").getTime();
      await seedMeterEvent(db, { id: "me-1", tenant: "t-1", charge: 1, cost: 0.5, timestamp: ts, capability: "llm" });

      const csv = await store.exportCsv(JAN_2026, "margin_by_capability");
      expect(csv).toContain("capability");
      expect(csv).toContain("llm");
    });

    it("exports tenant_health section", async () => {
      const csv = await store.exportCsv(JAN_2026, "tenant_health");
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
      const metrics = await store.getAutoTopupMetrics(JAN_2026);
      expect(metrics.totalEvents).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.failedCount).toBe(0);
      expect(metrics.revenueCents).toBe(0);
      expect(metrics.failureRate).toBe(0);
    });
  });
});
