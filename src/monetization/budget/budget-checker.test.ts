import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import { createTestDb } from "../../test/db.js";
import { BudgetChecker, type SpendLimits } from "./budget-checker.js";

/** Free tier limits (matching old DEFAULT_TIERS["free"]) */
const FREE_LIMITS: SpendLimits = {
  maxSpendPerHour: 0.5,
  maxSpendPerMonth: 5,
  label: "free",
};

/** Pro tier limits */
const PRO_LIMITS: SpendLimits = {
  maxSpendPerHour: 10,
  maxSpendPerMonth: 200,
  label: "pro",
};

/** Enterprise (unlimited) limits */
const ENTERPRISE_LIMITS: SpendLimits = {
  maxSpendPerHour: null,
  maxSpendPerMonth: null,
  label: "enterprise",
};

describe("BudgetChecker", () => {
  let db: DrizzleDb;
  let sqlite: import("better-sqlite3").Database;
  let checker: BudgetChecker;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    checker = new BudgetChecker(db, { cacheTtlMs: 1000 });
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("check()", () => {
    it("allows requests when spend is under limit", () => {
      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0);
      expect(result.currentMonthlySpend).toBe(0);
      expect(result.maxSpendPerHour).toBe(0.5);
      expect(result.maxSpendPerMonth).toBe(5);
    });

    it("blocks requests when hourly limit is exceeded", () => {
      // Insert events to exceed hourly limit ($0.50)
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.3,
          charge: 0.6,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Hourly spending limit exceeded");
      expect(result.httpStatus).toBe(429);
      expect(result.currentHourlySpend).toBe(0.6);
    });

    it("blocks requests when monthly limit is exceeded", () => {
      // Insert events to exceed monthly limit ($5.00)
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 2.5,
          charge: 5.0,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("spending limit exceeded");
      expect(result.httpStatus).toBe(429);
      // Could be hourly or monthly -- both are exceeded (5.0 >= 0.5 and 5.0 >= 5.0)
    });

    it("allows unlimited spend for enterprise tier", () => {
      const result = checker.check("tenant-ent", ENTERPRISE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBeNull();
      expect(result.maxSpendPerMonth).toBeNull();
    });

    it("uses custom per-tenant limits when provided", () => {
      const customLimits: SpendLimits = {
        maxSpendPerHour: 1.0,
        maxSpendPerMonth: 10.0,
        label: "custom",
      };

      checker.clearCache(); // Clear cache to force re-query

      const result = checker.check("tenant-1", customLimits);
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBe(1.0);
      expect(result.maxSpendPerMonth).toBe(10.0);
    });

    it("caches budget data to avoid repeated DB queries", () => {
      // First check
      const result1 = checker.check("tenant-1", FREE_LIMITS);
      expect(result1.allowed).toBe(true);

      // Add events (should not be reflected in cached result)
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.3,
          charge: 0.6,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      // Second check (should use cache)
      const result2 = checker.check("tenant-1", FREE_LIMITS);
      expect(result2.allowed).toBe(true);
      expect(result2.currentHourlySpend).toBe(0); // Cached value

      // Clear cache and check again
      checker.invalidate("tenant-1");
      const result3 = checker.check("tenant-1", FREE_LIMITS);
      expect(result3.allowed).toBe(false); // Now sees the new spend
      expect(result3.currentHourlySpend).toBe(0.6);
    });

    it("aggregates spend from both meter_events and usage_summaries", () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      // Add event in meter_events
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.1,
          charge: 0.2,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      // Add summary in usage_summaries
      db.insert(usageSummaries)
        .values({
          id: "sum-1",
          tenant: "tenant-1",
          capability: "chat",
          provider: "replicate",
          eventCount: 1,
          totalCost: 0.15,
          totalCharge: 0.3,
          totalDuration: 0,
          windowStart: oneHourAgo,
          windowEnd: now,
        })
        .run();

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false); // 0.2 + 0.3 = 0.5, which equals the limit
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("handles edge case: spend exactly at limit", () => {
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.25,
          charge: 0.5,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false); // >= limit
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("handles edge case: spend just under limit", () => {
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.24,
          charge: 0.49,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0.49);
    });

    it("ignores events outside the hourly time window", () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;

      // Old event (outside hourly window, but within monthly)
      db.insert(meterEvents)
        .values({
          id: "evt-old",
          tenant: "tenant-1",
          cost: 10,
          charge: 20,
          capability: "chat",
          provider: "replicate",
          timestamp: twoHoursAgo,
        })
        .run();

      checker.clearCache(); // Ensure fresh query

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false); // Blocked by monthly limit (20 > 5)
      expect(result.currentHourlySpend).toBe(0); // Old event ignored for hourly
      expect(result.currentMonthlySpend).toBe(20); // But counted for monthly
    });
  });

  describe("clearCache()", () => {
    it("clears all cached entries", () => {
      checker.check("tenant-1", FREE_LIMITS);
      checker.check("tenant-2", PRO_LIMITS);

      checker.clearCache();

      // Add events (should be reflected after cache clear)
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.3,
          charge: 0.6,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      const result = checker.check("tenant-1", FREE_LIMITS);
      expect(result.currentHourlySpend).toBe(0.6); // Fresh data
    });
  });

  describe("invalidate()", () => {
    it("invalidates cache for a specific tenant", () => {
      checker.check("tenant-1", FREE_LIMITS);
      checker.check("tenant-2", PRO_LIMITS);

      checker.invalidate("tenant-1");

      // Add events for tenant-1 (should be reflected after invalidation)
      const now = Date.now();
      db.insert(meterEvents)
        .values({
          id: "evt-1",
          tenant: "tenant-1",
          cost: 0.3,
          charge: 0.6,
          capability: "chat",
          provider: "replicate",
          timestamp: now,
        })
        .run();

      const result1 = checker.check("tenant-1", FREE_LIMITS);
      expect(result1.currentHourlySpend).toBe(0.6); // Fresh data

      const result2 = checker.check("tenant-2", PRO_LIMITS);
      expect(result2.currentHourlySpend).toBe(0); // Still cached
    });
  });
});
