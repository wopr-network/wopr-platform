import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initMeterSchema } from "../metering/schema.js";
import { DEFAULT_TIERS, TierStore } from "../quotas/tier-definitions.js";
import { BudgetChecker } from "./budget-checker.js";

describe("BudgetChecker", () => {
  let db: Database.Database;
  let checker: BudgetChecker;
  let tierStore: TierStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initMeterSchema(db);
    tierStore = new TierStore(db);
    tierStore.seed(DEFAULT_TIERS);
    checker = new BudgetChecker(db, { cacheTtlMs: 1000 });
  });

  afterEach(() => {
    db.close();
  });

  describe("check()", () => {
    it("allows requests when spend is under limit", () => {
      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0);
      expect(result.currentMonthlySpend).toBe(0);
      expect(result.maxSpendPerHour).toBe(0.5);
      expect(result.maxSpendPerMonth).toBe(5);
    });

    it("blocks requests when hourly limit is exceeded", () => {
      // Insert events to exceed hourly limit ($0.50)
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.3, 0.6, "chat", "replicate", now);

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Hourly spending limit exceeded");
      expect(result.httpStatus).toBe(429);
      expect(result.currentHourlySpend).toBe(0.6);
    });

    it("blocks requests when monthly limit is exceeded", () => {
      // Insert events to exceed monthly limit ($5.00)
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 2.5, 5.0, "chat", "replicate", now);

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("spending limit exceeded");
      expect(result.httpStatus).toBe(429);
      // Could be hourly or monthly — both are exceeded (5.0 >= 0.5 and 5.0 >= 5.0)
    });

    it("allows unlimited spend for enterprise tier", () => {
      const result = checker.check("tenant-ent", "enterprise");
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBeNull();
      expect(result.maxSpendPerMonth).toBeNull();
    });

    it("uses per-tenant overrides when available", () => {
      // Set custom limit for tenant
      db.prepare(
        "INSERT INTO tenant_spend_overrides (tenant, max_spend_per_hour, max_spend_per_month) VALUES (?, ?, ?)",
      ).run("tenant-1", 1.0, 10.0);

      checker.clearCache(); // Clear cache to force re-query

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBe(1.0);
      expect(result.maxSpendPerMonth).toBe(10.0);
    });

    it("caches budget data to avoid repeated DB queries", () => {
      // First check
      const result1 = checker.check("tenant-1", "free");
      expect(result1.allowed).toBe(true);

      // Add events (should not be reflected in cached result)
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.3, 0.6, "chat", "replicate", now);

      // Second check (should use cache)
      const result2 = checker.check("tenant-1", "free");
      expect(result2.allowed).toBe(true);
      expect(result2.currentHourlySpend).toBe(0); // Cached value

      // Clear cache and check again
      checker.invalidate("tenant-1");
      const result3 = checker.check("tenant-1", "free");
      expect(result3.allowed).toBe(false); // Now sees the new spend
      expect(result3.currentHourlySpend).toBe(0.6);
    });

    it("fails closed when tier is not found", () => {
      const result = checker.check("tenant-1", "invalid-tier");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unable to verify tier configuration");
      expect(result.httpStatus).toBe(500);
    });

    it("aggregates spend from both meter_events and usage_summaries", () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      // Add event in meter_events
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.1, 0.2, "chat", "replicate", now);

      // Add summary in usage_summaries
      db.prepare(
        "INSERT INTO usage_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("sum-1", "tenant-1", "chat", "replicate", 1, 0.15, 0.3, 0, oneHourAgo, now);

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(false); // 0.2 + 0.3 = 0.5, which equals the limit
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("handles edge case: spend exactly at limit", () => {
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.25, 0.5, "chat", "replicate", now);

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(false); // >= limit
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("handles edge case: spend just under limit", () => {
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.24, 0.49, "chat", "replicate", now);

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0.49);
    });

    it("ignores events outside the hourly time window", () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;

      // Old event (outside hourly window, but within monthly)
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-old", "tenant-1", 10, 20, "chat", "replicate", twoHoursAgo);

      checker.clearCache(); // Ensure fresh query

      const result = checker.check("tenant-1", "free");
      expect(result.allowed).toBe(false); // Blocked by monthly limit (20 > 5)
      expect(result.currentHourlySpend).toBe(0); // Old event ignored for hourly
      expect(result.currentMonthlySpend).toBe(20); // But counted for monthly
    });
  });

  describe("clearCache()", () => {
    it("clears all cached entries", () => {
      checker.check("tenant-1", "free");
      checker.check("tenant-2", "pro");

      checker.clearCache();

      // Add events (should be reflected after cache clear)
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.3, 0.6, "chat", "replicate", now);

      const result = checker.check("tenant-1", "free");
      expect(result.currentHourlySpend).toBe(0.6); // Fresh data
    });
  });

  describe("invalidate()", () => {
    it("invalidates cache for a specific tenant", () => {
      checker.check("tenant-1", "free");
      checker.check("tenant-2", "pro");

      checker.invalidate("tenant-1");

      // Add events for tenant-1 (should be reflected after invalidation)
      const now = Date.now();
      db.prepare(
        "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("evt-1", "tenant-1", 0.3, 0.6, "chat", "replicate", now);

      const result1 = checker.check("tenant-1", "free");
      expect(result1.currentHourlySpend).toBe(0.6); // Fresh data

      const result2 = checker.check("tenant-2", "pro");
      expect(result2.currentHourlySpend).toBe(0); // Still cached
    });
  });
});
