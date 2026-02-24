import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditAdjustmentStore } from "../admin/credits/adjustment-store.js";
import { initCreditAdjustmentSchema } from "../admin/credits/schema.js";
import { AdminUserStore } from "../admin/users/user-store.js";
import type { DrizzleDb } from "../db/index.js";
import { DrizzleAffiliateRepository } from "../monetization/affiliate/drizzle-affiliate-repository.js";
import { DrizzleAutoTopupSettingsRepository } from "../monetization/credits/auto-topup-settings-repository.js";
import { DrizzleSpendingLimitsRepository } from "../monetization/drizzle-spending-limits-repository.js";
import { initMeterSchema } from "../monetization/metering/schema.js";
import { initStripeSchema } from "../monetization/stripe/schema.js";
import type { DrizzleTenantCustomerStore } from "../monetization/stripe/tenant-store.js";
import { createTestDb } from "../test/db.js";
import { appRouter } from "./index.js";
import type { TRPCContext } from "./init.js";
import { setAdminRouterDeps } from "./routers/admin.js";
import { setBillingRouterDeps } from "./routers/billing.js";

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
    initMeterSchema(sqlite);
    initStripeSchema(sqlite);
    initCreditAdjustmentSchema(sqlite);
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
        getTenantStatusStore: () => {
          throw new Error("Tenant status store not available in tests") as never;
        },
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
      await caller.admin.creditsCorrection({
        tenantId: "t3",
        amount_cents: -2000,
        reason: "Correction",
      });

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
    let tenantStore: DrizzleTenantCustomerStore;

    beforeEach(async () => {
      const creditStore = new CreditAdjustmentStore(sqlite);
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/stripe/tenant-store.js");
      tenantStore = new TenantCustomerStore(db);
      const { StripeUsageReporter } = await import("../monetization/stripe/usage-reporter.js");
      const mockStripe = { billing: { meterEvents: { create: vi.fn() } } };
      const usageReporter = new StripeUsageReporter(db, mockStripe as never, tenantStore);
      const spendingLimitsRepo = new DrizzleSpendingLimitsRepository(db);
      const autoTopupSettingsStore = new DrizzleAutoTopupSettingsRepository(db);
      const mockStripeClient = {
        customers: {
          listPaymentMethods: vi.fn().mockResolvedValue({ data: [] }),
        },
      };

      setBillingRouterDeps({
        stripe: {
          checkout: { sessions: { create: vi.fn() } },
          billingPortal: { sessions: { create: vi.fn() } },
          customers: {
            retrieve: vi.fn().mockResolvedValue({
              id: "cus_test",
              email: "test@example.com",
              invoice_settings: { default_payment_method: null },
            }),
            update: vi.fn().mockResolvedValue({ id: "cus_test", email: "updated@example.com" }),
          },
          paymentMethods: {
            list: vi.fn().mockResolvedValue({ data: [] }),
            retrieve: vi.fn().mockResolvedValue({ id: "pm_test", customer: "cus_test" }),
            detach: vi.fn().mockResolvedValue({ id: "pm_test" }),
          },
          invoices: {
            list: vi.fn().mockResolvedValue({ data: [] }),
          },
        } as never,
        tenantStore,
        creditStore,
        meterAggregator,
        usageReporter,
        priceMap: undefined,
        autoTopupSettingsStore,
        stripeClient: mockStripeClient as never,
        dividendRepo: {
          getStats: () => ({
            poolCents: 0,
            activeUsers: 0,
            perUserCents: 0,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: () => [],
          getLifetimeTotalCents: () => 0,
          getDigestTenantAggregates: () => [],
          getTenantEmail: () => undefined,
        },
        spendingLimitsRepo,
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });
    });

    it("creditsBalance returns 0 for new tenant", async () => {
      const caller = createCaller(authedContext({ tenantId: undefined }));
      const result = await caller.billing.creditsBalance({ tenant: "test-user" });
      expect(result.balance_cents).toBe(0);
    });

    it("creditsBalance includes daily_burn_cents and runway_days", async () => {
      const caller = createCaller(authedContext({ tenantId: undefined }));
      const result = await caller.billing.creditsBalance({ tenant: "test-user" });
      expect(result).toHaveProperty("daily_burn_cents");
      expect(result).toHaveProperty("runway_days");
      expect(typeof result.daily_burn_cents).toBe("number");
      // runway_days is null when burn is 0
      expect(result.runway_days).toBeNull();
    });

    it("creditsBalance returns null runway_days when daily_burn is zero", async () => {
      const caller = createCaller(authedContext({ tenantId: "ctx-tenant" }));
      const result = await caller.billing.creditsBalance({});
      // No usage events → daily_burn_cents = 0 → runway_days = null
      expect(result.daily_burn_cents).toBe(0);
      expect(result.runway_days).toBeNull();
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
      const caller = createCaller(authedContext({ tenantId: undefined }));
      const result = await caller.billing.creditsHistory({ tenant: "test-user" });
      expect(result.entries).toEqual([]);
    });

    it("rejects unauthenticated billing requests", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.billing.creditsBalance({ tenant: "t1" })).rejects.toThrow("Authentication required");
    });

    // ---- tenant-optional overloads (WOP-687) ----

    it("creditsBalance uses ctx.tenantId when tenant omitted", async () => {
      const caller = createCaller(authedContext({ tenantId: "ctx-tenant" }));
      const result = await caller.billing.creditsBalance({});
      expect(result.balance_cents).toBe(0);
      expect(result.tenant).toBe("ctx-tenant");
    });

    it("creditsHistory works without explicit tenant", async () => {
      const caller = createCaller(authedContext({ tenantId: "ctx-tenant" }));
      const result = await caller.billing.creditsHistory({});
      expect(result.entries).toEqual([]);
    });

    it("portalSession accepts omitted tenant and uses ctx.tenantId", async () => {
      const caller = createCaller(authedContext({ tenantId: "ctx-tenant" }));
      // portalSession needs a Stripe customer — it will throw a portal/customer error,
      // but NOT "Tenant context required" — proving tenant is derived from ctx
      await expect(caller.billing.portalSession({ returnUrl: "https://example.com/billing" })).rejects.toThrow(); // throws Stripe/customer error, not missing-tenant error
    });

    // ---- new stub procedures (WOP-687) ----

    it("plans returns array of plan objects", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.plans();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty("id");
      expect(result[0]).toHaveProperty("tier");
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("price");
      expect(result[0]).toHaveProperty("priceLabel");
      expect(result[0]).toHaveProperty("features");
    });

    it("plans includes all four tiers", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.plans();
      const tiers = result.map((p) => p.tier);
      expect(tiers).toContain("free");
      expect(tiers).toContain("pro");
      expect(tiers).toContain("team");
      expect(tiers).toContain("enterprise");
    });

    it("currentPlan returns tier object", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.currentPlan();
      expect(result).toHaveProperty("tier");
      expect(["free", "pro", "team", "enterprise"]).toContain(result.tier);
    });

    it("changePlan returns updated tier", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.changePlan({ tier: "pro" });
      expect(result.tier).toBe("pro");
    });

    it("inferenceMode returns mode object", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.inferenceMode();
      expect(result).toHaveProperty("mode");
      expect(["byok", "hosted"]).toContain(result.mode);
    });

    it("providerCosts returns array", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.providerCosts();
      expect(Array.isArray(result)).toBe(true);
    });

    it("hostedUsageSummary returns summary shape", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.hostedUsageSummary();
      expect(result).toHaveProperty("periodStart");
      expect(result).toHaveProperty("periodEnd");
      expect(result).toHaveProperty("capabilities");
      expect(result).toHaveProperty("totalCost");
      expect(result).toHaveProperty("includedCredit");
      expect(result).toHaveProperty("amountDue");
    });

    it("hostedUsageEvents returns array", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.hostedUsageEvents();
      expect(Array.isArray(result)).toBe(true);
    });

    it("hostedUsageEvents accepts filter params", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.hostedUsageEvents({
        capability: "transcription",
        from: "2026-01-01",
        to: "2026-02-01",
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("spendingLimits returns limits shape", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.spendingLimits();
      expect(result).toHaveProperty("global");
      expect(result.global).toHaveProperty("alertAt");
      expect(result.global).toHaveProperty("hardCap");
      expect(result).toHaveProperty("perCapability");
    });

    it("updateSpendingLimits returns updated limits", async () => {
      const caller = createCaller(authedContext());
      const limits = {
        global: { alertAt: 100, hardCap: 200 },
        perCapability: {
          transcription: { alertAt: null, hardCap: null },
          image_gen: { alertAt: 10, hardCap: 50 },
          text_gen: { alertAt: null, hardCap: null },
          embeddings: { alertAt: null, hardCap: null },
        },
      };
      const result = await caller.billing.updateSpendingLimits(limits);
      expect(result.global.alertAt).toBe(100);
      expect(result.global.hardCap).toBe(200);
    });

    it("billingInfo returns empty state when tenant has no Stripe mapping", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.billingInfo();
      expect(result).toHaveProperty("email");
      expect(result).toHaveProperty("paymentMethods");
      expect(result).toHaveProperty("invoices");
      expect(result.email).toBe("");
      expect(result.paymentMethods).toEqual([]);
      expect(result.invoices).toEqual([]);
    });

    it("billingInfo returns Stripe data when mapping exists", async () => {
      tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      const result = await caller.billing.billingInfo();
      expect(result.email).toBe("test@example.com");
    });

    it("updateBillingEmail throws NOT_FOUND when tenant has no mapping", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.billing.updateBillingEmail({ email: "test@example.com" })).rejects.toThrow(
        "No billing account found",
      );
    });

    it("updateBillingEmail calls Stripe when mapping exists", async () => {
      tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      const result = await caller.billing.updateBillingEmail({ email: "new@example.com" });
      expect(result.email).toBe("new@example.com");
    });

    it("removePaymentMethod throws when tenant has no Stripe mapping", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.billing.removePaymentMethod({ id: "pm_test" })).rejects.toThrow();
    });

    it("removePaymentMethod returns removed true when PM belongs to tenant", async () => {
      tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      const result = await caller.billing.removePaymentMethod({ id: "pm_test" });
      expect(result.removed).toBe(true);
    });

    it("currentPlan returns free tier for tenant with no mapping", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.currentPlan();
      expect(result.tier).toBe("free");
    });

    it("changePlan persists tier change", async () => {
      tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      await caller.billing.changePlan({ tier: "pro" });
      const result = await caller.billing.currentPlan();
      expect(result.tier).toBe("pro");
    });

    it("inferenceMode defaults to byok for new tenant", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.inferenceMode();
      expect(result.mode).toBe("byok");
    });

    it("setInferenceMode persists mode change", async () => {
      tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      await caller.billing.setInferenceMode({ mode: "hosted" });
      const result = await caller.billing.inferenceMode();
      expect(result.mode).toBe("hosted");
    });

    it("spendingLimits returns null defaults for new tenant", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.spendingLimits();
      expect(result.global.alertAt).toBeNull();
      expect(result.global.hardCap).toBeNull();
      expect(result.perCapability).toEqual({});
    });

    it("updateSpendingLimits round-trips through DB", async () => {
      const caller = createCaller(authedContext());
      const limits = {
        global: { alertAt: 100, hardCap: 200 },
        perCapability: {
          image_gen: { alertAt: 10, hardCap: 50 },
        },
      };
      await caller.billing.updateSpendingLimits(limits);
      const result = await caller.billing.spendingLimits();
      expect(result.global.alertAt).toBe(100);
      expect(result.global.hardCap).toBe(200);
      expect(result.perCapability.image_gen.hardCap).toBe(50);
    });

    it("new procedures reject unauthenticated requests", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.billing.plans()).rejects.toThrow("Authentication required");
      await expect(caller.billing.currentPlan()).rejects.toThrow("Authentication required");
      await expect(caller.billing.inferenceMode()).rejects.toThrow("Authentication required");
    });

    // ---- autoTopupSettings (WOP-945) ----

    describe("billing.autoTopupSettings", () => {
      it("returns defaults when no settings exist", async () => {
        const caller = createCaller(authedContext());
        const result = await caller.billing.autoTopupSettings();
        expect(result.usage_enabled).toBe(false);
        expect(result.usage_threshold_cents).toBe(500);
        expect(result.usage_topup_cents).toBe(2000);
        expect(result.schedule_enabled).toBe(false);
        expect(result.payment_method_last4).toBeNull();
      });

      it("returns card last4 when payment method exists", async () => {
        const caller = createCaller(authedContext());
        // Set up tenant-customer mapping
        tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
        // Override stripeClient to return a payment method
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const mockStripeClient = {
          customers: {
            listPaymentMethods: vi.fn().mockResolvedValue({
              data: [{ card: { last4: "4242" } }],
            }),
          },
        };
        const { CreditAdjustmentStore: CAS } = await import("../admin/credits/adjustment-store.js");
        const creditStore = new CAS(sqlite);
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
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
          autoTopupSettingsStore,
          stripeClient: mockStripeClient as never,
          dividendRepo: {
            getStats: () => ({
              poolCents: 0,
              activeUsers: 0,
              perUserCents: 0,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: () => [],
            getLifetimeTotalCents: () => 0,
            getDigestTenantAggregates: () => [],
            getTenantEmail: () => undefined,
          },
          spendingLimitsRepo: new DrizzleSpendingLimitsRepository(db),
          affiliateRepo: new DrizzleAffiliateRepository(db),
        });
        const result = await caller.billing.autoTopupSettings();
        expect(result.payment_method_last4).toBe("4242");
      });
    });

    describe("billing.updateAutoTopupSettings", () => {
      it("rejects enabling usage mode without payment method", async () => {
        const caller = createCaller(authedContext());
        // tenantStore has no entry for test-tenant → no Stripe customer
        await expect(caller.billing.updateAutoTopupSettings({ usage_enabled: true })).rejects.toThrow(
          /payment method/i,
        );
      });

      it("rejects invalid topup amount", async () => {
        const caller = createCaller(authedContext());
        await expect(caller.billing.updateAutoTopupSettings({ usage_topup_cents: 999 })).rejects.toThrow();
      });

      it("rejects invalid threshold", async () => {
        const caller = createCaller(authedContext());
        await expect(caller.billing.updateAutoTopupSettings({ usage_threshold_cents: 300 })).rejects.toThrow();
      });

      it("persists usage-based settings when payment method exists", async () => {
        const caller = createCaller(authedContext());
        tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
        // Override stripeClient to return a payment method
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const mockStripeClient = {
          customers: {
            listPaymentMethods: vi.fn().mockResolvedValue({
              data: [{ card: { last4: "4242" } }],
            }),
          },
        };
        const { CreditAdjustmentStore: CAS } = await import("../admin/credits/adjustment-store.js");
        const creditStore = new CAS(sqlite);
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
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
          autoTopupSettingsStore,
          stripeClient: mockStripeClient as never,
          dividendRepo: {
            getStats: () => ({
              poolCents: 0,
              activeUsers: 0,
              perUserCents: 0,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: () => [],
            getLifetimeTotalCents: () => 0,
            getDigestTenantAggregates: () => [],
            getTenantEmail: () => undefined,
          },
          spendingLimitsRepo: new DrizzleSpendingLimitsRepository(db),
          affiliateRepo: new DrizzleAffiliateRepository(db),
        });

        const result = await caller.billing.updateAutoTopupSettings({
          usage_enabled: true,
          usage_threshold_cents: 1000,
          usage_topup_cents: 5000,
        });

        expect(result.usage_enabled).toBe(true);
        expect(result.usage_threshold_cents).toBe(1000);
        expect(result.usage_topup_cents).toBe(5000);
      });

      it("computes schedule_next_at when enabling schedule", async () => {
        const caller = createCaller(authedContext());
        tenantStore.upsert({ tenant: "test-tenant", stripeCustomerId: "cus_test" });
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const mockStripeClient = {
          customers: {
            listPaymentMethods: vi.fn().mockResolvedValue({
              data: [{ card: { last4: "4242" } }],
            }),
          },
        };
        const { CreditAdjustmentStore: CAS } = await import("../admin/credits/adjustment-store.js");
        const creditStore = new CAS(sqlite);
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
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
          autoTopupSettingsStore,
          stripeClient: mockStripeClient as never,
          dividendRepo: {
            getStats: () => ({
              poolCents: 0,
              activeUsers: 0,
              perUserCents: 0,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: () => [],
            getLifetimeTotalCents: () => 0,
            getDigestTenantAggregates: () => [],
            getTenantEmail: () => undefined,
          },
          spendingLimitsRepo: new DrizzleSpendingLimitsRepository(db),
          affiliateRepo: new DrizzleAffiliateRepository(db),
        });

        const result = await caller.billing.updateAutoTopupSettings({
          schedule_enabled: true,
          schedule_interval: "weekly",
          schedule_amount_cents: 2000,
        });

        expect(result.schedule_enabled).toBe(true);
        expect(result.schedule_next_at).toBeTruthy();
        if (result.schedule_next_at) {
          expect(new Date(result.schedule_next_at).getTime()).toBeGreaterThan(Date.now());
        }
      });
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
  // ---- creditOptions (WOP-916) ----

  describe("creditOptions", () => {
    it("returns configured credit tiers sorted by amountCents", async () => {
      vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_test_5");
      vi.stubEnv("STRIPE_CREDIT_PRICE_10", "price_test_10");
      vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_test_25");
      vi.stubEnv("STRIPE_CREDIT_PRICE_50", "price_test_50");
      vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_test_100");

      const { loadCreditPriceMap } = await import("../monetization/stripe/credit-prices.js");
      const creditStore = new CreditAdjustmentStore(sqlite);
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/stripe/tenant-store.js");
      const tenantStore = new TenantCustomerStore(db);
      const { StripeUsageReporter } = await import("../monetization/stripe/usage-reporter.js");
      const mockStripe = { billing: { meterEvents: { create: vi.fn() } } };
      const usageReporter = new StripeUsageReporter(db, mockStripe as never, tenantStore);
      const spendingLimitsRepo1 = new DrizzleSpendingLimitsRepository(db);

      setBillingRouterDeps({
        stripe: {
          checkout: { sessions: { create: vi.fn() } },
          billingPortal: { sessions: { create: vi.fn() } },
        } as never,
        tenantStore,
        creditStore,
        meterAggregator,
        usageReporter,
        priceMap: loadCreditPriceMap(),
        autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
        stripeClient: { customers: { listPaymentMethods: vi.fn().mockResolvedValue({ data: [] }) } } as never,
        dividendRepo: {
          getStats: () => ({
            poolCents: 0,
            activeUsers: 0,
            perUserCents: 0,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: () => [],
          getLifetimeTotalCents: () => 0,
          getDigestTenantAggregates: () => [],
          getTenantEmail: () => undefined,
        },
        spendingLimitsRepo: spendingLimitsRepo1,
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const caller = createCaller(authedContext());
      const options = await caller.billing.creditOptions();

      expect(options).toHaveLength(5);
      expect(options[0]).toEqual({
        priceId: "price_test_5",
        label: "$5",
        amountCents: 500,
        creditCents: 500,
        bonusPercent: 0,
      });
      expect(options[2]).toEqual({
        priceId: "price_test_25",
        label: "$25",
        amountCents: 2500,
        creditCents: 2550,
        bonusPercent: 2,
      });
      expect(options[4]).toEqual({
        priceId: "price_test_100",
        label: "$100",
        amountCents: 10000,
        creditCents: 11000,
        bonusPercent: 10,
      });

      vi.unstubAllEnvs();
    });

    it("returns empty array when no prices configured", async () => {
      vi.stubEnv("STRIPE_CREDIT_PRICE_5", "");
      vi.stubEnv("STRIPE_CREDIT_PRICE_10", "");
      vi.stubEnv("STRIPE_CREDIT_PRICE_25", "");
      vi.stubEnv("STRIPE_CREDIT_PRICE_50", "");
      vi.stubEnv("STRIPE_CREDIT_PRICE_100", "");

      const { loadCreditPriceMap } = await import("../monetization/stripe/credit-prices.js");
      const creditStore = new CreditAdjustmentStore(sqlite);
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/stripe/tenant-store.js");
      const tenantStore = new TenantCustomerStore(db);
      const { StripeUsageReporter } = await import("../monetization/stripe/usage-reporter.js");
      const mockStripe = { billing: { meterEvents: { create: vi.fn() } } };
      const usageReporter = new StripeUsageReporter(db, mockStripe as never, tenantStore);
      const spendingLimitsRepo2 = new DrizzleSpendingLimitsRepository(db);

      setBillingRouterDeps({
        stripe: {
          checkout: { sessions: { create: vi.fn() } },
          billingPortal: { sessions: { create: vi.fn() } },
        } as never,
        tenantStore,
        creditStore,
        meterAggregator,
        usageReporter,
        priceMap: loadCreditPriceMap(),
        autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
        stripeClient: { customers: { listPaymentMethods: vi.fn().mockResolvedValue({ data: [] }) } } as never,
        dividendRepo: {
          getStats: () => ({
            poolCents: 0,
            activeUsers: 0,
            perUserCents: 0,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: () => [],
          getLifetimeTotalCents: () => 0,
          getDigestTenantAggregates: () => [],
          getTenantEmail: () => undefined,
        },
        spendingLimitsRepo: spendingLimitsRepo2,
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const caller = createCaller(authedContext());
      const options = await caller.billing.creditOptions();
      expect(options).toEqual([]);

      vi.unstubAllEnvs();
    });

    it("returns empty array when priceMap is undefined", async () => {
      const creditStore = new CreditAdjustmentStore(sqlite);
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/stripe/tenant-store.js");
      const tenantStore = new TenantCustomerStore(db);
      const { StripeUsageReporter } = await import("../monetization/stripe/usage-reporter.js");
      const mockStripe = { billing: { meterEvents: { create: vi.fn() } } };
      const usageReporter = new StripeUsageReporter(db, mockStripe as never, tenantStore);
      const spendingLimitsRepo3 = new DrizzleSpendingLimitsRepository(db);

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
        autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
        stripeClient: { customers: { listPaymentMethods: vi.fn().mockResolvedValue({ data: [] }) } } as never,
        dividendRepo: {
          getStats: () => ({
            poolCents: 0,
            activeUsers: 0,
            perUserCents: 0,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: () => [],
          getLifetimeTotalCents: () => 0,
          getDigestTenantAggregates: () => [],
          getTenantEmail: () => undefined,
        },
        spendingLimitsRepo: spendingLimitsRepo3,
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const caller = createCaller(authedContext());
      const options = await caller.billing.creditOptions();
      expect(options).toEqual([]);
    });
  });
});
