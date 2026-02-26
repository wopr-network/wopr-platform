import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import { createTestDb } from "../../test/db.js";
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

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    checker = new BudgetChecker(db, { cacheTtlMs: 1000 });
  });

  afterEach(async () => {
    await pool.close();
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
        cost: 0.3,
        charge: 0.6,
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
        cost: 2.5,
        charge: 5.0,
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
        cost: 0.3,
        charge: 0.6,
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

      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: 0.1,
        charge: 0.2,
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      await db.insert(usageSummaries).values({
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
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(false);
      expect(result.currentHourlySpend).toBe(0.5);
    });

    it("handles edge case: spend exactly at limit", async () => {
      const now = Date.now();
      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "tenant-1",
        cost: 0.25,
        charge: 0.5,
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
        cost: 0.24,
        charge: 0.49,
        capability: "chat",
        provider: "replicate",
        timestamp: now,
      });

      const result = await checker.check("tenant-1", FREE_LIMITS);
      expect(result.allowed).toBe(true);
      expect(result.currentHourlySpend).toBe(0.49);
    });

    it("ignores events outside the hourly time window", async () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;

      await db.insert(meterEvents).values({
        id: "evt-old",
        tenant: "tenant-1",
        cost: 10,
        charge: 20,
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
        cost: 0.3,
        charge: 0.6,
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
        cost: 0.3,
        charge: 0.6,
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
