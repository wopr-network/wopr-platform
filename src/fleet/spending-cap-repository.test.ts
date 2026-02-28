/**
 * Unit tests for DrizzleSpendingCapStore (WOP-1116).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { Credit } from "../monetization/credit.js";
import { createTestDb, seedMeterEvent, seedUsageSummary, truncateAllTables } from "../test/db.js";
import { DrizzleSpendingCapStore, getDayStart, getMonthStart } from "./spending-cap-repository.js";

describe("getDayStart UTC", () => {
  it("returns midnight UTC for the given timestamp", () => {
    // 2024-03-15T14:30:00Z
    const ts = Date.UTC(2024, 2, 15, 14, 30, 0);
    const result = getDayStart(ts);
    expect(result).toBe(Date.UTC(2024, 2, 15, 0, 0, 0, 0));
  });

  it("returns UTC midnight for a mid-day timestamp", () => {
    const now = new Date("2026-02-15T14:30:00Z").getTime();
    const result = getDayStart(now);
    expect(result).toBe(new Date("2026-02-15T00:00:00Z").getTime());
  });

  it("returns same value when already at UTC midnight", () => {
    const now = new Date("2026-02-15T00:00:00Z").getTime();
    expect(getDayStart(now)).toBe(now);
  });

  it("returns UTC midnight even for timestamps near end of day", () => {
    const now = new Date("2026-02-15T23:59:59.999Z").getTime();
    expect(getDayStart(now)).toBe(new Date("2026-02-15T00:00:00Z").getTime());
  });
});

describe("getMonthStart UTC", () => {
  it("returns the first of the month at midnight UTC", () => {
    // 2024-03-15T14:30:00Z
    const ts = Date.UTC(2024, 2, 15, 14, 30, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2024, 2, 1, 0, 0, 0, 0));
  });

  it("uses UTC month, not local month (boundary test)", () => {
    // 2024-04-01T00:30:00Z — in UTC-5 this would still be March 31
    // The function receives a UTC timestamp, so it must return April 1 UTC.
    const ts = Date.UTC(2024, 3, 1, 0, 30, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2024, 3, 1, 0, 0, 0, 0));
  });

  it("handles December correctly", () => {
    const ts = Date.UTC(2024, 11, 25, 10, 0, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2024, 11, 1, 0, 0, 0, 0));
  });

  it("handles January correctly", () => {
    const ts = Date.UTC(2025, 0, 15, 10, 0, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2025, 0, 1, 0, 0, 0, 0));
  });

  it("returns first of month at UTC midnight", () => {
    const now = new Date("2026-02-15T14:30:00Z").getTime();
    expect(getMonthStart(now)).toBe(new Date("2026-02-01T00:00:00Z").getTime());
  });

  it("returns same value when already at month start", () => {
    const now = new Date("2026-02-01T00:00:00Z").getTime();
    expect(getMonthStart(now)).toBe(now);
  });

  it("handles month boundaries correctly (last day of month)", () => {
    const now = new Date("2026-01-31T23:59:59Z").getTime();
    expect(getMonthStart(now)).toBe(new Date("2026-01-01T00:00:00Z").getTime());
  });

  it("handles year boundaries (January 1st)", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    expect(getMonthStart(now)).toBe(new Date("2026-01-01T00:00:00Z").getTime());
  });
});

describe("DrizzleSpendingCapStore", () => {
  let store: DrizzleSpendingCapStore;
  let db: DrizzleDb;
  let pool: PGlite;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new DrizzleSpendingCapStore(db);
  });

  describe("period rollover", () => {
    it("excludes yesterday meter_events from today daily spend", async () => {
      const yesterdayTs = new Date("2026-02-14T10:00:00Z").getTime();
      const todayTs = new Date("2026-02-15T10:00:00Z").getTime();
      const chargeRaw = Credit.fromDollars(1.5).toRaw();

      await seedMeterEvent(db, { id: "me-yesterday", tenant: "t1", charge: chargeRaw, timestamp: yesterdayTs });
      await seedMeterEvent(db, { id: "me-today", tenant: "t1", charge: chargeRaw, timestamp: todayTs });

      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const result = await store.querySpend("t1", now);

      // Daily should only include today's $1.50
      expect(result.dailySpend).toBeCloseTo(1.5, 6);
      // Monthly should include both ($3.00) — both are in Feb
      expect(result.monthlySpend).toBeCloseTo(3.0, 6);
    });
  });

  describe("increment and read", () => {
    it("returns updated totals after inserting meter_events", async () => {
      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const chargeRaw = Credit.fromDollars(2.0).toRaw();

      await seedMeterEvent(db, { id: "me-1", tenant: "t1", charge: chargeRaw, timestamp: now - 3600_000 });

      const result = await store.querySpend("t1", now);
      expect(result.dailySpend).toBeCloseTo(2.0, 6);
      expect(result.monthlySpend).toBeCloseTo(2.0, 6);
    });

    it("returns updated totals after inserting usage_summaries", async () => {
      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const chargeRaw = Credit.fromDollars(3.0).toRaw();
      const dayStart = new Date("2026-02-15T00:00:00Z").getTime();

      await seedUsageSummary(db, {
        id: "us-1",
        tenant: "t1",
        totalCharge: chargeRaw,
        windowStart: dayStart,
        windowEnd: now,
      });

      const result = await store.querySpend("t1", now);
      expect(result.dailySpend).toBeCloseTo(3.0, 6);
      expect(result.monthlySpend).toBeCloseTo(3.0, 6);
    });

    it("sums both meter_events and usage_summaries", async () => {
      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const dayStart = new Date("2026-02-15T00:00:00Z").getTime();

      await seedMeterEvent(db, {
        id: "me-combo",
        tenant: "t1",
        charge: Credit.fromDollars(1.0).toRaw(),
        timestamp: now - 3600_000,
      });
      await seedUsageSummary(db, {
        id: "us-combo",
        tenant: "t1",
        totalCharge: Credit.fromDollars(2.0).toRaw(),
        windowStart: dayStart,
        windowEnd: now,
        eventCount: 5,
      });

      const result = await store.querySpend("t1", now);
      expect(result.dailySpend).toBeCloseTo(3.0, 6);
      expect(result.monthlySpend).toBeCloseTo(3.0, 6);
    });
  });

  describe("per-tenant isolation", () => {
    it("tenant A spend does not appear in tenant B query", async () => {
      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const chargeRaw = Credit.fromDollars(5.0).toRaw();

      await seedMeterEvent(db, { id: "me-a", tenant: "tenant-a", charge: chargeRaw, timestamp: now - 1000 });
      await seedMeterEvent(db, { id: "me-b", tenant: "tenant-b", charge: chargeRaw, timestamp: now - 1000 });

      const resultA = await store.querySpend("tenant-a", now);
      const resultB = await store.querySpend("tenant-b", now);

      expect(resultA.dailySpend).toBeCloseTo(5.0, 6);
      expect(resultA.monthlySpend).toBeCloseTo(5.0, 6);
      expect(resultB.dailySpend).toBeCloseTo(5.0, 6);
      expect(resultB.monthlySpend).toBeCloseTo(5.0, 6);

      // A third tenant with no data should return 0
      const resultC = await store.querySpend("tenant-c", now);
      expect(resultC.dailySpend).toBeCloseTo(0, 6);
      expect(resultC.monthlySpend).toBeCloseTo(0, 6);
    });
  });

  describe("daily vs monthly accumulation", () => {
    it("monthly accumulates across multiple days while daily resets", async () => {
      const chargeRaw = Credit.fromDollars(10.0).toRaw();

      await seedMeterEvent(db, {
        id: "me-feb10",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: new Date("2026-02-10T12:00:00Z").getTime(),
      });
      await seedMeterEvent(db, {
        id: "me-feb12",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: new Date("2026-02-12T12:00:00Z").getTime(),
      });
      await seedMeterEvent(db, {
        id: "me-feb15",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: new Date("2026-02-15T10:00:00Z").getTime(),
      });

      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const result = await store.querySpend("t1", now);

      // Daily: only Feb 15 = $10
      expect(result.dailySpend).toBeCloseTo(10.0, 5);
      // Monthly: Feb 10 + Feb 12 + Feb 15 = $30
      expect(result.monthlySpend).toBeCloseTo(30.0, 5);
    });

    it("previous month spend excluded from monthly total", async () => {
      const chargeRaw = Credit.fromDollars(10.0).toRaw();

      // Jan 31 spend should NOT appear in Feb monthly
      await seedMeterEvent(db, {
        id: "me-jan31",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: new Date("2026-01-31T23:00:00Z").getTime(),
      });
      await seedMeterEvent(db, {
        id: "me-feb01",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: new Date("2026-02-01T01:00:00Z").getTime(),
      });

      const now = new Date("2026-02-15T14:00:00Z").getTime();
      const result = await store.querySpend("t1", now);

      // Daily: neither is today, so 0
      expect(result.dailySpend).toBeCloseTo(0, 6);
      // Monthly: only Feb 1 = $10 (Jan 31 excluded)
      expect(result.monthlySpend).toBeCloseTo(10.0, 6);
    });
  });
});
