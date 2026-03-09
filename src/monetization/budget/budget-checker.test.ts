import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { Credit } from "../credit.js";
import { BudgetChecker, type SpendLimits } from "./budget-checker.js";

const FREE_LIMITS: SpendLimits = {
  maxSpendPerHour: 0.5,
  maxSpendPerMonth: 5,
  label: "free",
};

const PRO_LIMITS: SpendLimits = {
  maxSpendPerHour: 10,
  maxSpendPerMonth: 200,
  label: "pro",
};

const ENTERPRISE_LIMITS: SpendLimits = {
  maxSpendPerHour: null,
  maxSpendPerMonth: null,
  label: "enterprise",
};

describe("BudgetChecker", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let checker: BudgetChecker;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    checker = new BudgetChecker(db, { cacheTtlMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("check()", () => {
    it("allows requests when spend is under limit", async () => {
      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0);
      expect(result.currentMonthlySpend).toBe(0);
      expect(result.maxSpendPerHour).toBe(0.5);
      expect(result.maxSpendPerMonth).toBe(5);
    });

    it("blocks requests when hourly limit is exceeded", async () => {
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.3).toRaw(),
        charge: Credit.fromDollars(0.6).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Hourly spending limit exceeded");
      expect(result.httpStatus).toBe(429);
      expect(result.currentHourlySpend).toBe(0.6);
    });

    it("blocks requests when monthly limit is exceeded", async () => {
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(2.5).toRaw(),
        charge: Credit.fromDollars(5.0).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("spending limit exceeded");
      expect(result.httpStatus).toBe(429);
    });

    it("allows unlimited spend for enterprise tier", async () => {
      const result = await checker.check("tenant-ent", ENTERPRISE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBeNull();
      expect(result.maxSpendPerMonth).toBeNull();
    });

    it("reflects upgraded limits immediately without cache invalidation", async () => {
      const now = Date.now();
      // Insert spend that exceeds FREE but is under PRO
      await db.insert(meterEvents).values({
        id: crypto.randomUUID(),
        tenant: "tenant-upgrade",
        cost: Credit.fromDollars(0.5).toRaw(),
        charge: Credit.fromDollars(1.0).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      // First check with FREE limits — should be blocked (1.0 >= 0.5)
      const result1 = await checker.check("tenant-upgrade", FREE_LIMITS);
      expect(result1.allowed).toBe(false);
      expect(result1.maxSpendPerHour).toBe(0.5);

      // Second check with PRO limits — should be allowed (1.0 < 10)
      // WITHOUT calling invalidate() or clearCache()
      const result2 = await checker.check("tenant-upgrade", PRO_LIMITS);
      expect(result2.allowed).toBe(true);
      expect(result2.maxSpendPerHour).toBe(10);
      expect(result2.maxSpendPerMonth).toBe(200);
      expect(result2.currentHourlySpend).toBe(1.0);
    });

    it("uses custom per-tenant limits when provided", async () => {
      const customLimits: SpendLimits = {
        maxSpendPerHour: 1.0,
        maxSpendPerMonth: 10.0,
        label: "custom",
      };
      checker.clearCache();
      const result = await checker.check("tenant-1", customLimits);
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBe(1.0);
      expect(result.maxSpendPerMonth).toBe(10.0);
    });

    it("caches budget data to avoid repeated DB queries", async () => {
      const result1 = await checker.check("tenant-1", FREE_LIMITS);
      expect(result1.allowed).toBe(true);

      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.3).toRaw(),
        charge: Credit.fromDollars(0.6).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result2 = await checker.check("tenant-1", FREE_LIMITS);
      expect(result2.allowed).toBe(true);
      expect(result2.currentHourlySpend).toBe(0);

      checker.invalidate("tenant-1");
      const result3 = await checker.check("tenant-1", FREE_LIMITS);
      expect(result3.allowed).toBe(false);
      expect(result3.currentHourlySpend).toBe(0.6);
    });

    it("aggregates spend from both meter_events and usage_summaries", async () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const thirtyMinAgo = now - 30 * 60 * 1000;

      // Summary covers [1h ago, 30min ago)
      await db.insert(usageSummaries).values({
        id: "sum-1",
        tenant: "tenant-1",
        capability: "chat",
        provider: "replicate",
        eventCount: 1,
        totalCost: Credit.fromDollars(0.15).toRaw(),
        totalCharge: Credit.fromDollars(0.3).toRaw(),
        totalDuration: 0,
        windowStart: oneHourAgo,
        windowEnd: thirtyMinAgo,
      });

      // New event AFTER summary window
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.1).toRaw(),
        charge: Credit.fromDollars(0.2).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false); // $0.50 >= $0.50 hourly limit
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("does not double-count meter_events already rolled into usage_summaries", async () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      // A meter_event that was already rolled up into a usage_summary
      await db.insert(meterEvents).values({
        id: "evt-rolled",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.15).toRaw(),
        charge: Credit.fromDollars(0.3).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now - 30 * 60 * 1000, // 30 min ago
      });

      // The summary covering that event's window
      await db.insert(usageSummaries).values({
        id: "sum-rolled",
        tenant: "tenant-1",
        capability: "chat",
        provider: "replicate",
        eventCount: 1,
        totalCost: Credit.fromDollars(0.15).toRaw(),
        totalCharge: Credit.fromDollars(0.3).toRaw(),
        totalDuration: 0,
        windowStart: oneHourAgo,
        windowEnd: now - 20 * 60 * 1000, // window ended 20 min ago
      });

      checker.clearCache();
      const result = await checker.check("tenant-1", FREE_LIMITS);

      // Should be $0.30 (from summary only), NOT $0.60 (double-counted)
      expect(result.currentHourlySpend).toBe(0.3);
      expect(result.allowed).toBe(true); // $0.30 < $0.50 hourly limit
    });

    it("includes unsummarized meter_events after latest summary window", async () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      // Summary covering [1h ago, 30min ago)
      await db.insert(usageSummaries).values({
        id: "sum-old",
        tenant: "tenant-1",
        capability: "chat",
        provider: "replicate",
        eventCount: 1,
        totalCost: Credit.fromDollars(0.05).toRaw(),
        totalCharge: Credit.fromDollars(0.1).toRaw(),
        totalDuration: 0,
        windowStart: oneHourAgo,
        windowEnd: now - 30 * 60 * 1000,
      });

      // New event at 10min ago — not yet rolled up
      await db.insert(meterEvents).values({
        id: "evt-new",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.1).toRaw(),
        charge: Credit.fromDollars(0.2).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now - 10 * 60 * 1000,
      });

      checker.clearCache();
      const result = await checker.check("tenant-1", FREE_LIMITS);

      // $0.10 summary + $0.20 new event = $0.30
      expect(result.currentHourlySpend).toBe(0.3);
    });

    it("handles edge case: spend exactly at limit", async () => {
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.25).toRaw(),
        charge: Credit.fromDollars(0.5).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("handles edge case: spend just under limit", async () => {
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.24).toRaw(),
        charge: Credit.fromDollars(0.49).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0.49);
    });

    it("does not serve stale spend data across an hour boundary", async () => {
      // Freeze time at a known point and populate cache
      const baseNow = new Date("2026-02-15T11:59:00.000Z").getTime();
      vi.useFakeTimers();
      vi.setSystemTime(baseNow);

      const result1 = await checker.check("tenant-boundary", FREE_LIMITS);
      expect(result1.allowed).toBe(true);
      expect(result1.currentHourlySpend).toBe(0);

      // Advance past the hour boundary — new bucket, cache should miss
      vi.setSystemTime(baseNow + 2 * 60 * 1000); // +2 minutes → into next hour

      await db.insert(meterEvents).values({
        id: crypto.randomUUID(),
        tenant: "tenant-boundary",
        cost: Credit.fromDollars(0.3).toRaw(),
        charge: Credit.fromDollars(0.6).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: baseNow + 2 * 60 * 1000,
      });

      // Fresh DB query because the hour bucket changed
      const result2 = await checker.check("tenant-boundary", FREE_LIMITS);
      expect(result2.allowed).toBe(false);
      expect(result2.currentHourlySpend).toBe(0.6);
    });

    it("ignores events outside the hourly time window", async () => {
      // Freeze mid-month so twoHoursAgo never crosses a month boundary
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-15T12:00:00.000Z"));
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;

      await db.insert(meterEvents).values({
        id: "evt-old",
        tenant: "tenant-1",
        cost: Credit.fromDollars(10).toRaw(),
        charge: Credit.fromDollars(20).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: twoHoursAgo,
      });

      checker.clearCache();

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.currentHourlySpend).toBe(0);
      expect(result.currentMonthlySpend).toBe(20);
    });
  });

  describe("clearCache()", () => {
    it("clears all cached entries", async () => {
      await checker.check("tenant-1", FREE_LIMITS);
      await checker.check("tenant-2", PRO_LIMITS);

      checker.clearCache();

      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.3).toRaw(),
        charge: Credit.fromDollars(0.6).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.currentHourlySpend).toBe(0.6);
    });
  });

  describe("invalidate()", () => {
    it("invalidates cache for a specific tenant", async () => {
      await checker.check("tenant-1", FREE_LIMITS);
      await checker.check("tenant-2", PRO_LIMITS);

      checker.invalidate("tenant-1");

      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: Credit.fromDollars(0.3).toRaw(),
        charge: Credit.fromDollars(0.6).toRaw(),
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result1 = await checker.check("tenant-1", FREE_LIMITS);
      expect(result1.currentHourlySpend).toBe(0.6);

      const result2 = await checker.check("tenant-2", PRO_LIMITS);
      expect(result2.currentHourlySpend).toBe(0);
    });
  });
});
