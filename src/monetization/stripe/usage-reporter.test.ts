import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/index.js";
import type { DrizzleDb } from "../../db/index.js";
import { initMeterSchema } from "../metering/schema.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";
import { StripeUsageReporter } from "./usage-reporter.js";

describe("StripeUsageReporter", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let tenantStore: TenantCustomerStore;
  let mockMeterEvents: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initMeterSchema(sqlite);
    initStripeSchema(sqlite);
    db = createDb(sqlite);
    tenantStore = new TenantCustomerStore(db);
    mockMeterEvents = vi.fn().mockResolvedValue({});
  });

  afterEach(() => {
    sqlite.close();
  });

  function mockStripe() {
    return {
      billing: {
        meterEvents: {
          create: mockMeterEvents,
        },
      },
    } as unknown as Stripe;
  }

  let summaryCounter = 0;
  function insertBillingPeriodSummary(opts: {
    tenant: string;
    capability: string;
    provider: string;
    eventCount: number;
    totalCharge: number;
    periodStart: number;
    periodEnd: number;
  }) {
    summaryCounter++;
    sqlite.prepare(`
      INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
    `).run(`bps-${summaryCounter}`, opts.tenant, opts.capability, opts.provider, opts.eventCount, opts.totalCharge, opts.periodStart, opts.periodEnd, Date.now());
  }

  describe("report", () => {
    it("returns 0 when no unreported summaries", async () => {
      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const count = await reporter.report();
      expect(count).toBe(0);
    });

    it("skips tenants without Stripe customer mapping", async () => {
      insertBillingPeriodSummary({
        tenant: "no-stripe-tenant",
        capability: "chat",
        provider: "openrouter",
        eventCount: 5,
        totalCharge: 1.5,
        periodStart: 1000,
        periodEnd: 2000,
      });

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const count = await reporter.report();
      expect(count).toBe(0);
      expect(mockMeterEvents).not.toHaveBeenCalled();
    });

    it("reports usage for tenant with Stripe customer", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      insertBillingPeriodSummary({
        tenant: "t-1",
        capability: "chat",
        provider: "openrouter",
        eventCount: 10,
        totalCharge: 2.50,
        periodStart: 1000000,
        periodEnd: 2000000,
      });

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const count = await reporter.report();

      expect(count).toBe(1);
      expect(mockMeterEvents).toHaveBeenCalledWith({
        event_name: "wopr_chat_usage",
        timestamp: 1000, // periodStart / 1000
        payload: {
          stripe_customer_id: "cus_abc",
          value: "250", // 2.50 * 100 = 250 cents
        },
      });
    });

    it("marks zero-charge periods as reported without calling Stripe", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      insertBillingPeriodSummary({
        tenant: "t-1",
        capability: "chat",
        provider: "openrouter",
        eventCount: 3,
        totalCharge: 0,
        periodStart: 1000000,
        periodEnd: 2000000,
      });

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const count = await reporter.report();

      expect(count).toBe(1);
      expect(mockMeterEvents).not.toHaveBeenCalled();
    });

    it("does not re-report already reported periods (idempotent)", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      insertBillingPeriodSummary({
        tenant: "t-1",
        capability: "chat",
        provider: "openrouter",
        eventCount: 10,
        totalCharge: 5.0,
        periodStart: 1000000,
        periodEnd: 2000000,
      });

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);

      // First report
      const first = await reporter.report();
      expect(first).toBe(1);

      // Second report - should find nothing unreported
      const second = await reporter.report();
      expect(second).toBe(0);
    });

    it("stops on first Stripe API error", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      insertBillingPeriodSummary({
        tenant: "t-1",
        capability: "chat",
        provider: "openrouter",
        eventCount: 10,
        totalCharge: 1.0,
        periodStart: 1000000,
        periodEnd: 2000000,
      });
      insertBillingPeriodSummary({
        tenant: "t-1",
        capability: "voice",
        provider: "elevenlabs",
        eventCount: 5,
        totalCharge: 3.0,
        periodStart: 1000000,
        periodEnd: 2000000,
      });

      mockMeterEvents.mockRejectedValueOnce(new Error("Stripe rate limit"));

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const count = await reporter.report();

      // Should stop after first failure
      expect(count).toBe(0);
      expect(mockMeterEvents).toHaveBeenCalledTimes(1);
    });

    it("skips __sentinel__ tenant", async () => {
      tenantStore.upsert({ tenant: "__sentinel__", stripeCustomerId: "cus_sentinel" });
      insertBillingPeriodSummary({
        tenant: "__sentinel__",
        capability: "chat",
        provider: "test",
        eventCount: 1,
        totalCharge: 1.0,
        periodStart: 1000,
        periodEnd: 2000,
      });

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const count = await reporter.report();
      expect(count).toBe(0);
    });
  });

  describe("queryReports", () => {
    it("returns reports for a tenant", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      insertBillingPeriodSummary({
        tenant: "t-1",
        capability: "chat",
        provider: "openrouter",
        eventCount: 10,
        totalCharge: 2.0,
        periodStart: 1000000,
        periodEnd: 2000000,
      });

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      await reporter.report();

      const reports = reporter.queryReports("t-1");
      expect(reports).toHaveLength(1);
      expect(reports[0].tenant).toBe("t-1");
      expect(reports[0].capability).toBe("chat");
      expect(reports[0].value_cents).toBe(200);
    });

    it("returns empty array for unknown tenant", () => {
      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      const reports = reporter.queryReports("unknown");
      expect(reports).toHaveLength(0);
    });

    it("respects limit parameter", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });
      // Insert multiple periods
      for (let i = 0; i < 5; i++) {
        insertBillingPeriodSummary({
          tenant: "t-1",
          capability: "chat",
          provider: `provider-${i}`,
          eventCount: 1,
          totalCharge: 1.0,
          periodStart: i * 1000000,
          periodEnd: (i + 1) * 1000000,
        });
      }

      const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
      await reporter.report();

      const reports = reporter.queryReports("t-1", { limit: 2 });
      expect(reports).toHaveLength(2);
    });
  });

  describe("start and stop", () => {
    it("starts and stops periodic reporting", () => {
      vi.useFakeTimers();
      try {
        const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
        reporter.start(1000);

        // Should not throw or fail
        reporter.stop();

        // Double stop is safe
        reporter.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not start twice", () => {
      vi.useFakeTimers();
      try {
        const reporter = new StripeUsageReporter(db, mockStripe(), tenantStore);
        reporter.start(1000);
        reporter.start(1000); // Should be no-op

        reporter.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
