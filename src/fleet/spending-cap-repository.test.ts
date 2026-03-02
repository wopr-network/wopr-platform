/**
 * Unit tests for DrizzleSpendingCapStore (WOP-1116).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { Credit } from "../monetization/credit.js";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
  seedMeterEvent,
  seedUsageSummary,
} from "../test/db.js";
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
    const now = new Date("2026-02-15T23:59:59Z").getTime();
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
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    expect(getMonthStart(now)).toBe(new Date("2026-01-01T00:00:00Z").getTime());
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

  // Anchor to the 15th of a month at noon UTC — mid-month, safe from boundary issues
  const ANCHOR = new Date("2026-03-15T14:00:00Z");
  const ANCHOR_TS = ANCHOR.getTime();

  // The start of the anchor's month
  const MONTH_START = new Date("2026-03-01T00:00:00Z").getTime();

  // The start of the anchor's day
  const DAY_START = new Date("2026-03-15T00:00:00Z").getTime();

  // A timestamp in the previous month (will be excluded from monthly totals)
  const PREV_MONTH_TS = new Date("2026-02-28T23:00:00Z").getTime();

  // A timestamp in the current month but a previous day
  const PREV_DAY_TS = new Date("2026-03-10T12:00:00Z").getTime();

  // A timestamp earlier today
  const TODAY_TS = DAY_START + 2 * 60 * 60 * 1000; // 02:00 today

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    await rollbackTestTransaction(pool);
    store = new DrizzleSpendingCapStore(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("period rollover", () => {
    it("excludes yesterday meter_events from today daily spend", async () => {
      const chargeRaw = Credit.fromDollars(1.5).toRaw();

      await seedMeterEvent(db, { id: "me-yesterday", tenant: "t1", charge: chargeRaw, timestamp: PREV_DAY_TS });
      await seedMeterEvent(db, { id: "me-today", tenant: "t1", charge: chargeRaw, timestamp: TODAY_TS });

      const result = await store.querySpend("t1", ANCHOR_TS);

      // Daily should only include today's $1.50
      expect(result.dailySpend).toBeCloseTo(1.5, 6);
      // Monthly should include both ($3.00) — both are in the same month
      expect(result.monthlySpend).toBeCloseTo(3.0, 6);
    });
  });

  describe("increment and read", () => {
    it("returns updated totals after inserting meter_events", async () => {
      const chargeRaw = Credit.fromDollars(2.0).toRaw();

      await seedMeterEvent(db, { id: "me-1", tenant: "t1", charge: chargeRaw, timestamp: ANCHOR_TS - 3600_000 });

      const result = await store.querySpend("t1", ANCHOR_TS);
      expect(result.dailySpend).toBeCloseTo(2.0, 6);
      expect(result.monthlySpend).toBeCloseTo(2.0, 6);
    });

    it("returns updated totals after inserting usage_summaries", async () => {
      const chargeRaw = Credit.fromDollars(3.0).toRaw();

      await seedUsageSummary(db, {
        id: "us-1",
        tenant: "t1",
        totalCharge: chargeRaw,
        windowStart: DAY_START,
        windowEnd: ANCHOR_TS,
      });

      const result = await store.querySpend("t1", ANCHOR_TS);
      expect(result.dailySpend).toBeCloseTo(3.0, 6);
      expect(result.monthlySpend).toBeCloseTo(3.0, 6);
    });

    it("sums both meter_events and usage_summaries", async () => {
      await seedMeterEvent(db, {
        id: "me-combo",
        tenant: "t1",
        charge: Credit.fromDollars(1.0).toRaw(),
        timestamp: ANCHOR_TS - 3600_000,
      });
      await seedUsageSummary(db, {
        id: "us-combo",
        tenant: "t1",
        totalCharge: Credit.fromDollars(2.0).toRaw(),
        windowStart: DAY_START,
        windowEnd: ANCHOR_TS,
        eventCount: 5,
      });

      const result = await store.querySpend("t1", ANCHOR_TS);
      expect(result.dailySpend).toBeCloseTo(3.0, 6);
      expect(result.monthlySpend).toBeCloseTo(3.0, 6);
    });
  });

  describe("per-tenant isolation", () => {
    it("tenant A spend does not appear in tenant B query", async () => {
      const chargeRaw = Credit.fromDollars(5.0).toRaw();

      await seedMeterEvent(db, { id: "me-a", tenant: "tenant-a", charge: chargeRaw, timestamp: ANCHOR_TS - 1000 });
      await seedMeterEvent(db, { id: "me-b", tenant: "tenant-b", charge: chargeRaw, timestamp: ANCHOR_TS - 1000 });

      const resultA = await store.querySpend("tenant-a", ANCHOR_TS);
      const resultB = await store.querySpend("tenant-b", ANCHOR_TS);

      expect(resultA.dailySpend).toBeCloseTo(5.0, 6);
      expect(resultA.monthlySpend).toBeCloseTo(5.0, 6);
      expect(resultB.dailySpend).toBeCloseTo(5.0, 6);
      expect(resultB.monthlySpend).toBeCloseTo(5.0, 6);

      // A third tenant with no data should return 0
      const resultC = await store.querySpend("tenant-c", ANCHOR_TS);
      expect(resultC.dailySpend).toBeCloseTo(0, 6);
      expect(resultC.monthlySpend).toBeCloseTo(0, 6);
    });
  });

  describe("daily vs monthly accumulation", () => {
    it("monthly accumulates across multiple days while daily resets", async () => {
      const chargeRaw = Credit.fromDollars(10.0).toRaw();

      // Three events earlier in the same month on different days
      await seedMeterEvent(db, {
        id: "me-day5",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: MONTH_START + 5 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000, // 5th at noon
      });
      await seedMeterEvent(db, {
        id: "me-day7",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: MONTH_START + 7 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000, // 7th at noon
      });
      await seedMeterEvent(db, {
        id: "me-today",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: TODAY_TS, // today at 02:00
      });

      const result = await store.querySpend("t1", ANCHOR_TS);

      // Daily: only today's event = $10
      expect(result.dailySpend).toBeCloseTo(10.0, 5);
      // Monthly: all three = $30
      expect(result.monthlySpend).toBeCloseTo(30.0, 5);
    });

    it("previous month spend excluded from monthly total", async () => {
      const chargeRaw = Credit.fromDollars(10.0).toRaw();

      // Previous month spend should NOT appear in current month total
      await seedMeterEvent(db, {
        id: "me-prev-month",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: PREV_MONTH_TS,
      });
      await seedMeterEvent(db, {
        id: "me-curr-month",
        tenant: "t1",
        charge: chargeRaw,
        timestamp: MONTH_START + 1 * 60 * 60 * 1000, // 1 hour into current month
      });

      const result = await store.querySpend("t1", ANCHOR_TS);

      // Daily: neither is today, so 0
      expect(result.dailySpend).toBeCloseTo(0, 6);
      // Monthly: only current month event = $10 (prev month excluded)
      expect(result.monthlySpend).toBeCloseTo(10.0, 6);
    });
  });
});
