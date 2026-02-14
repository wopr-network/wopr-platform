import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditAdjustmentStore } from "../admin/credits/adjustment-store.js";
import { initCreditAdjustmentSchema } from "../admin/credits/schema.js";
import { initAdminUsersSchema } from "../admin/users/schema.js";
import { AdminUserStore } from "../admin/users/user-store.js";
import { createDb, type DrizzleDb } from "../db/index.js";
import { initMeterSchema } from "../monetization/metering/schema.js";
import { initStripeSchema } from "../monetization/stripe/schema.js";
import { appRouter } from "./index.js";
import type { TRPCContext } from "./init.js";
import { setAdminRouterDeps } from "./routers/admin.js";
import { setBillingRouterDeps } from "./routers/billing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("journal_mode = WAL");
  initMeterSchema(sqlite);
  initStripeSchema(sqlite);
  initCreditAdjustmentSchema(sqlite);
  initAdminUsersSchema(sqlite);
  const db = createDb(sqlite);
  return { sqlite, db };
}

function authedContext(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    user: { id: "test-user", roles: ["admin"] },
    tenantId: "test-tenant",
    ...overrides,
  };
}

function unauthContext(): TRPCContext {
  return { user: undefined, tenantId: undefined };
}

/** Create a tRPC caller with the given context. */
function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tRPC appRouter", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = testDb.db;
  });

  afterEach(() => {
    sqlite.close();
  });

  // -------------------------------------------------------------------------
  // Settings router
  // -------------------------------------------------------------------------

  describe("settings", () => {
    it("health returns ok without auth", async () => {
      const caller = createCaller(unauthContext());
      const result = await caller.settings.health();
      expect(result).toEqual({ status: "ok", service: "wopr-platform" });
    });

    it("ping requires auth", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.settings.ping()).rejects.toThrow("Authentication required");
    });

    it("ping requires tenant context", async () => {
      const caller = createCaller({ user: { id: "u1", roles: ["admin"] }, tenantId: undefined });
      await expect(caller.settings.ping()).rejects.toThrow("Tenant context required");
    });

    it("ping returns tenant and user info", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.settings.ping();
      expect(result.ok).toBe(true);
      expect(result.tenantId).toBe("test-tenant");
      expect(result.userId).toBe("test-user");
      expect(result.timestamp).toBeTypeOf("number");
    });

    it("tenantConfig returns config", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.settings.tenantConfig();
      expect(result.tenantId).toBe("test-tenant");
      expect(result.configured).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Admin router
  // -------------------------------------------------------------------------

  describe("admin", () => {
    beforeEach(() => {
      const creditStore = new CreditAdjustmentStore(sqlite);
      const userStore = new AdminUserStore(sqlite);

      setAdminRouterDeps({
        getAuditLog: () => {
          throw new Error("Audit log not available in tests");
        },
        getCreditStore: () => creditStore,
        getUserStore: () => userStore,
      });
    });

    it("creditsBalance returns 0 for new tenant", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.admin.creditsBalance({ tenantId: "new-tenant" });
      expect(result.balance_cents).toBe(0);
      expect(result.tenant).toBe("new-tenant");
    });

    it("creditsGrant grants credits", async () => {
      const caller = createCaller(authedContext());
      await caller.admin.creditsGrant({ tenantId: "t1", amount_cents: 5000, reason: "Test grant" });

      const balance = await caller.admin.creditsBalance({ tenantId: "t1" });
      expect(balance.balance_cents).toBe(5000);
    });

    it("creditsRefund refunds credits", async () => {
      const caller = createCaller(authedContext());
      await caller.admin.creditsGrant({ tenantId: "t2", amount_cents: 10000, reason: "Initial" });
      await caller.admin.creditsRefund({ tenantId: "t2", amount_cents: 3000, reason: "Refund" });

      const balance = await caller.admin.creditsBalance({ tenantId: "t2" });
      expect(balance.balance_cents).toBe(7000);
    });

    it("creditsCorrection applies correction", async () => {
      const caller = createCaller(authedContext());
      await caller.admin.creditsGrant({ tenantId: "t3", amount_cents: 5000, reason: "Initial" });
      await caller.admin.creditsCorrection({ tenantId: "t3", amount_cents: -2000, reason: "Correction" });

      const balance = await caller.admin.creditsBalance({ tenantId: "t3" });
      expect(balance.balance_cents).toBe(3000);
    });

    it("creditsTransactions returns history", async () => {
      const caller = createCaller(authedContext());
      await caller.admin.creditsGrant({ tenantId: "t4", amount_cents: 1000, reason: "First" });
      await caller.admin.creditsGrant({ tenantId: "t4", amount_cents: 2000, reason: "Second" });

      const result = await caller.admin.creditsTransactions({ tenantId: "t4" });
      expect(result.entries).toHaveLength(2);
    });

    it("creditsGrant rejects unauthenticated", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.admin.creditsGrant({ tenantId: "t1", amount_cents: 5000, reason: "Test" })).rejects.toThrow(
        "Authentication required",
      );
    });

    it("usersList returns empty list initially", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.admin.usersList({});
      expect(result.users).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Billing router
  // -------------------------------------------------------------------------

  describe("billing", () => {
    beforeEach(async () => {
      const creditStore = new CreditAdjustmentStore(sqlite);
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/stripe/tenant-store.js");
      const tenantStore = new TenantCustomerStore(db);
      const { StripeUsageReporter } = await import("../monetization/stripe/usage-reporter.js");
      const mockStripe = { billing: { meterEvents: { create: vi.fn() } } };
      const usageReporter = new StripeUsageReporter(db, mockStripe as never, tenantStore);

      setBillingRouterDeps({
        stripe: {
          checkout: { sessions: { create: vi.fn() } },
          billingPortal: { sessions: { create: vi.fn() } },
        } as never,
        tenantStore,
        creditStore,
        meterAggregator,
        usageReporter,
        priceMap: undefined,
      });
    });

    it("creditsBalance returns 0 for new tenant", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.creditsBalance({ tenant: "new-tenant" });
      expect(result.balance_cents).toBe(0);
    });

    it("usage returns empty for tenant with no events", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.usage({ tenant: "test-tenant" });
      expect(result.tenant).toBe("test-tenant");
      expect(result.usage).toEqual([]);
    });

    it("usageSummary returns zeros for empty tenant", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.usageSummary({ tenant: "test-tenant" });
      expect(result.tenant).toBe("test-tenant");
      expect(result.total_cost).toBe(0);
      expect(result.total_charge).toBe(0);
      expect(result.event_count).toBe(0);
    });

    it("usageHistory returns empty for no reports", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.usageHistory({ tenant: "test-tenant" });
      expect(result.tenant).toBe("test-tenant");
      expect(result.reports).toEqual([]);
    });

    it("usage enforces tenant isolation", async () => {
      const caller = createCaller(authedContext({ tenantId: "tenant-a" }));
      await expect(caller.billing.usage({ tenant: "tenant-b" })).rejects.toThrow("Forbidden");
    });

    it("creditsHistory returns transactions", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.creditsHistory({ tenant: "new-tenant" });
      expect(result.entries).toEqual([]);
    });

    it("rejects unauthenticated billing requests", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.billing.creditsBalance({ tenant: "t1" })).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // Usage router
  // -------------------------------------------------------------------------

  describe("usage", () => {
    it("quota returns usage info", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.usage.quota({ activeInstances: 0 });
      expect(result).toHaveProperty("allowed");
      expect(result).toHaveProperty("currentInstances");
      expect(result).toHaveProperty("maxInstances");
    });

    it("quotaCheck allows creation under limit", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.usage.quotaCheck({ activeInstances: 0, softCap: false });
      expect(result.allowed).toBe(true);
    });

    it("resourceLimits returns container limits", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.usage.resourceLimits();
      expect(result).toHaveProperty("Memory");
    });
  });
});
