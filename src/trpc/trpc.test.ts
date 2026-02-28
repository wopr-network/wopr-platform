import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAdminAuditLogRepository } from "../admin/admin-audit-log-repository.js";
import { AdminAuditLog } from "../admin/audit-log.js";
import { AdminUserStore } from "../admin/users/user-store.js";
import type { DrizzleDb } from "../db/index.js";
import { DrizzleAffiliateRepository } from "../monetization/affiliate/drizzle-affiliate-repository.js";
import { Credit } from "../monetization/credit.js";
import { DrizzleAutoTopupSettingsRepository } from "../monetization/credits/auto-topup-settings-repository.js";
import type { ICreditLedger } from "../monetization/credits/credit-ledger.js";
import { DrizzleSpendingLimitsRepository } from "../monetization/drizzle-spending-limits-repository.js";
import type { DrizzleTenantCustomerStore } from "../monetization/index.js";
import type { IPaymentProcessor } from "../monetization/payment-processor.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { appRouter } from "./index.js";
import type { TRPCContext } from "./init.js";
import { setTrpcOrgMemberRepo } from "./init.js";
import { setAdminRouterDeps } from "./routers/admin.js";
import { setBillingRouterDeps } from "./routers/billing.js";

function authedContext(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    user: { id: "test-user", roles: ["admin"] },
    tenantId: "test-tenant",
    ...overrides,
  };
}

function adminAuthedContext(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    user: { id: "test-user", roles: ["platform_admin"] },
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

function createMockProcessor(overrides: Partial<IPaymentProcessor> = {}): IPaymentProcessor {
  return {
    name: "mock",
    supportsPortal: () => true,
    createCheckoutSession: vi
      .fn()
      .mockResolvedValue({ id: "cs_test", url: "https://pay.example.com/checkout/cs_test" }),
    createPortalSession: vi.fn().mockResolvedValue({ url: "https://pay.example.com/portal/portal_test" }),
    handleWebhook: vi.fn().mockResolvedValue({ handled: false, eventType: "unknown" }),
    setupPaymentMethod: vi.fn().mockResolvedValue({ clientSecret: "seti_test_secret" }),
    listPaymentMethods: vi.fn().mockResolvedValue([]),
    detachPaymentMethod: vi.fn().mockResolvedValue(undefined),
    charge: vi.fn().mockResolvedValue({ success: true }),
    getCustomerEmail: vi.fn().mockResolvedValue(""),
    updateCustomerEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMockLedger(): ICreditLedger {
  const balances = new Map<string, number>();
  const txns: import("../monetization/credits/credit-ledger.js").CreditTransaction[] = [];
  return {
    async credit(tenantId, amount, type, description) {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) + cents);
      const tx: import("../monetization/credits/credit-ledger.js").CreditTransaction = {
        id: crypto.randomUUID(),
        tenantId,
        amount,
        balanceAfter: Credit.fromCents(balances.get(tenantId) ?? 0),
        type: type ?? "signup_grant",
        description: description ?? null,
        referenceId: null,
        fundingSource: null,
        attributedUserId: null,
        createdAt: new Date().toISOString(),
      };
      txns.push(tx);
      return tx;
    },
    async debit(tenantId, amount, type, description) {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) - cents);
      const tx: import("../monetization/credits/credit-ledger.js").CreditTransaction = {
        id: crypto.randomUUID(),
        tenantId,
        amount: amount.multiply(-1),
        balanceAfter: Credit.fromCents(balances.get(tenantId) ?? 0),
        type: type ?? "correction",
        description: description ?? null,
        referenceId: null,
        fundingSource: null,
        attributedUserId: null,
        createdAt: new Date().toISOString(),
      };
      txns.push(tx);
      return tx;
    },
    async balance(tenantId) {
      return Credit.fromCents(balances.get(tenantId) ?? 0);
    },
    async hasReferenceId() {
      return false;
    },
    async history(tenantId, opts) {
      return txns
        .filter((t) => t.tenantId === tenantId)
        .slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 50));
    },
    async tenantsWithBalance() {
      return [];
    },
    async memberUsage(_tenantId: string) {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tRPC appRouter", () => {
  let db: DrizzleDb;

  let pool: PGlite;

  beforeAll(async () => {
    const testDb = await createTestDb();
    pool = testDb.pool;
    db = testDb.db;

    // Wire a stub org member repo so tenant access checks always pass in tests.
    // Tests that verify IDOR rejection should use a separate repo stub that returns null.
    setTrpcOrgMemberRepo({
      findMember: async () => ({
        id: "m1",
        orgId: "test-tenant",
        userId: "test-user",
        role: "owner",
        joinedAt: Date.now(),
      }),
      listMembers: async () => [],
      addMember: async () => {},
      updateMemberRole: async () => {},
      removeMember: async () => {},
      countAdminsAndOwners: async () => 1,
      listInvites: async () => [],
      createInvite: async () => {},
      findInviteById: async () => null,
      findInviteByToken: async () => null,
      deleteInvite: async () => {},
    });
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
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
    beforeEach(async () => {
      const creditLedger = makeMockLedger();
      const userStore = new AdminUserStore(db);

      const auditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db));
      setAdminRouterDeps({
        getAuditLog: () => auditLog,
        getCreditLedger: () => creditLedger,
        getUserStore: () => userStore,
        getTenantStatusStore: () => {
          throw new Error("Tenant status store not available in tests") as never;
        },
      });
    });

    it("creditsBalance returns 0 for new tenant", async () => {
      const caller = createCaller(adminAuthedContext());
      const result = await caller.admin.creditsBalance({ tenantId: "new-tenant" });
      expect(result.balance_cents).toBe(0);
      expect(result.tenant).toBe("new-tenant");
    });

    it("creditsGrant grants credits", async () => {
      const caller = createCaller(adminAuthedContext());
      await caller.admin.creditsGrant({ tenantId: "t1", amount_cents: 5000, reason: "Test grant" });

      const balance = await caller.admin.creditsBalance({ tenantId: "t1" });
      expect(balance.balance_cents).toBe(5000);
    });

    it("creditsRefund refunds credits", async () => {
      const caller = createCaller(adminAuthedContext());
      await caller.admin.creditsGrant({ tenantId: "t2", amount_cents: 10000, reason: "Initial" });
      await caller.admin.creditsRefund({ tenantId: "t2", amount_cents: 3000, reason: "Refund" });

      const balance = await caller.admin.creditsBalance({ tenantId: "t2" });
      expect(balance.balance_cents).toBe(7000);
    });

    it("creditsCorrection applies correction", async () => {
      const caller = createCaller(adminAuthedContext());
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
      const caller = createCaller(adminAuthedContext());
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
      const caller = createCaller(adminAuthedContext());
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
      const creditLedger = makeMockLedger();
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/index.js");
      tenantStore = new TenantCustomerStore(db);
      const spendingLimitsRepo = new DrizzleSpendingLimitsRepository(db);
      const autoTopupSettingsStore = new DrizzleAutoTopupSettingsRepository(db);

      setBillingRouterDeps({
        processor: createMockProcessor(),
        tenantStore,
        creditLedger,
        meterAggregator,
        priceMap: undefined,
        autoTopupSettingsStore,
        dividendRepo: {
          getStats: async () => ({
            pool: Credit.ZERO,
            activeUsers: 0,
            perUser: Credit.ZERO,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: async () => [],
          getLifetimeTotal: async () => Credit.ZERO,
          getDigestTenantAggregates: async () => [],
          getTenantEmail: async () => undefined,
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
      // With IPaymentProcessor mock, portalSession resolves successfully — proving tenant is derived from ctx
      const result = await caller.billing.portalSession({ returnUrl: "https://example.com/billing" });
      expect(result).toHaveProperty("url");
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

    it("billingInfo returns empty state when tenant has no processor mapping", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.billing.billingInfo();
      expect(result).toHaveProperty("email");
      expect(result).toHaveProperty("paymentMethods");
      expect(result).toHaveProperty("invoices");
      expect(result.email).toBe("");
      expect(result.paymentMethods).toEqual([]);
      expect(result.invoices).toEqual([]);
    });

    it("billingInfo returns payment methods from processor when mapping exists", async () => {
      tenantStore.upsert({ tenant: "test-tenant", processorCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      const result = await caller.billing.billingInfo();
      expect(result).toHaveProperty("email");
      expect(result).toHaveProperty("paymentMethods");
      expect(result).toHaveProperty("invoices");
    });

    it("updateBillingEmail throws NOT_FOUND when tenant has no mapping", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.billing.updateBillingEmail({ email: "test@example.com" })).rejects.toThrow(
        "No billing account found",
      );
    });

    it("updateBillingEmail calls processor when mapping exists", async () => {
      tenantStore.upsert({ tenant: "test-tenant", processorCustomerId: "cus_test" });
      const caller = createCaller(authedContext());
      const result = await caller.billing.updateBillingEmail({ email: "new@example.com" });
      expect(result.email).toBe("new@example.com");
    });

    it("removePaymentMethod succeeds via processor even when tenant has no billing mapping", async () => {
      const caller = createCaller(authedContext());
      // With IPaymentProcessor mock, detachPaymentMethod resolves regardless of tenant mapping
      const result = await caller.billing.removePaymentMethod({ id: "pm_test" });
      expect(result.removed).toBe(true);
    });

    it("removePaymentMethod returns removed true when PM belongs to tenant", async () => {
      tenantStore.upsert({ tenant: "test-tenant", processorCustomerId: "cus_test" });
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
      tenantStore.upsert({ tenant: "test-tenant", processorCustomerId: "cus_test" });
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
      tenantStore.upsert({ tenant: "test-tenant", processorCustomerId: "cus_test" });
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
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const creditLedger = makeMockLedger();
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
        setBillingRouterDeps({
          processor: createMockProcessor({
            listPaymentMethods: vi
              .fn()
              .mockResolvedValue([{ id: "pm_test", label: "Visa ending 4242", isDefault: true }]),
          }),
          tenantStore,
          creditLedger,
          meterAggregator,
          priceMap: undefined,
          autoTopupSettingsStore,
          dividendRepo: {
            getStats: async () => ({
              pool: Credit.ZERO,
              activeUsers: 0,
              perUser: Credit.ZERO,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: async () => [],
            getLifetimeTotal: async () => Credit.ZERO,
            getDigestTenantAggregates: async () => [],
            getTenantEmail: async () => undefined,
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
        // tenantStore has no entry for test-tenant → no processor customer
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
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const creditLedger = makeMockLedger();
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
        setBillingRouterDeps({
          processor: createMockProcessor({
            listPaymentMethods: vi
              .fn()
              .mockResolvedValue([{ id: "pm_test", label: "Visa ending 4242", isDefault: true }]),
          }),
          tenantStore,
          creditLedger,
          meterAggregator,
          priceMap: undefined,
          autoTopupSettingsStore,
          dividendRepo: {
            getStats: async () => ({
              pool: Credit.ZERO,
              activeUsers: 0,
              perUser: Credit.ZERO,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: async () => [],
            getLifetimeTotal: async () => Credit.ZERO,
            getDigestTenantAggregates: async () => [],
            getTenantEmail: async () => undefined,
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
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const creditLedger = makeMockLedger();
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
        setBillingRouterDeps({
          processor: createMockProcessor({
            listPaymentMethods: vi
              .fn()
              .mockResolvedValue([{ id: "pm_test", label: "Visa ending 4242", isDefault: true }]),
          }),
          tenantStore,
          creditLedger,
          meterAggregator,
          priceMap: undefined,
          autoTopupSettingsStore,
          dividendRepo: {
            getStats: async () => ({
              pool: Credit.ZERO,
              activeUsers: 0,
              perUser: Credit.ZERO,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: async () => [],
            getLifetimeTotal: async () => Credit.ZERO,
            getDigestTenantAggregates: async () => [],
            getTenantEmail: async () => undefined,
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

      it("persists scheduleIntervalHours and returns it on read-back", async () => {
        const { DrizzleAutoTopupSettingsRepository: Store } = await import(
          "../monetization/credits/auto-topup-settings-repository.js"
        );
        const autoTopupSettingsStore = new Store(db);
        const creditLedger = makeMockLedger();
        const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
        const meterAggregator = new MeterAggregator(db);
        setBillingRouterDeps({
          processor: createMockProcessor({
            listPaymentMethods: async () => [{ id: "pm_1", label: "Visa ending 4242", isDefault: true }],
          }),
          tenantStore,
          creditLedger,
          meterAggregator,
          priceMap: undefined,
          autoTopupSettingsStore,
          dividendRepo: {
            getStats: async () => ({
              pool: Credit.ZERO,
              activeUsers: 0,
              perUser: Credit.ZERO,
              nextDistributionAt: new Date().toISOString(),
              userEligible: false,
              userLastPurchaseAt: null,
              userWindowExpiresAt: null,
            }),
            getHistory: async () => [],
            getLifetimeTotal: async () => Credit.ZERO,
            getDigestTenantAggregates: async () => [],
            getTenantEmail: async () => undefined,
          },
          spendingLimitsRepo: new DrizzleSpendingLimitsRepository(db),
          affiliateRepo: new DrizzleAffiliateRepository(db),
        });

        const caller = createCaller(authedContext());

        // Update with daily schedule
        const updateResult = await caller.billing.updateAutoTopupSettings({
          schedule_enabled: true,
          schedule_interval: "daily",
          schedule_amount_cents: 2000,
        });
        expect(updateResult.schedule_interval_hours).toBe(24);

        // Read back
        const readResult = await caller.billing.autoTopupSettings();
        expect(readResult.schedule_interval_hours).toBe(24);

        // Update to weekly
        const weeklyResult = await caller.billing.updateAutoTopupSettings({
          schedule_interval: "weekly",
        });
        expect(weeklyResult.schedule_interval_hours).toBe(168);

        // Read back weekly
        const readWeekly = await caller.billing.autoTopupSettings();
        expect(readWeekly.schedule_interval_hours).toBe(168);
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
      const creditLedger = makeMockLedger();
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/index.js");
      const tenantStore = new TenantCustomerStore(db);
      const spendingLimitsRepo1 = new DrizzleSpendingLimitsRepository(db);

      setBillingRouterDeps({
        processor: createMockProcessor(),
        tenantStore,
        creditLedger,
        meterAggregator,
        priceMap: loadCreditPriceMap(),
        autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
        dividendRepo: {
          getStats: async () => ({
            pool: Credit.ZERO,
            activeUsers: 0,
            perUser: Credit.ZERO,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: async () => [],
          getLifetimeTotal: async () => Credit.ZERO,
          getDigestTenantAggregates: async () => [],
          getTenantEmail: async () => undefined,
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
      const creditLedger = makeMockLedger();
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/index.js");
      const tenantStore = new TenantCustomerStore(db);
      const spendingLimitsRepo2 = new DrizzleSpendingLimitsRepository(db);

      setBillingRouterDeps({
        processor: createMockProcessor(),
        tenantStore,
        creditLedger,
        meterAggregator,
        priceMap: loadCreditPriceMap(),
        autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
        dividendRepo: {
          getStats: async () => ({
            pool: Credit.ZERO,
            activeUsers: 0,
            perUser: Credit.ZERO,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: async () => [],
          getLifetimeTotal: async () => Credit.ZERO,
          getDigestTenantAggregates: async () => [],
          getTenantEmail: async () => undefined,
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
      const creditLedger = makeMockLedger();
      const { MeterAggregator } = await import("../monetization/metering/aggregator.js");
      const meterAggregator = new MeterAggregator(db);
      const { TenantCustomerStore } = await import("../monetization/index.js");
      const tenantStore = new TenantCustomerStore(db);
      const spendingLimitsRepo3 = new DrizzleSpendingLimitsRepository(db);

      setBillingRouterDeps({
        processor: createMockProcessor(),
        tenantStore,
        creditLedger,
        meterAggregator,
        priceMap: undefined,
        autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
        dividendRepo: {
          getStats: async () => ({
            pool: Credit.ZERO,
            activeUsers: 0,
            perUser: Credit.ZERO,
            nextDistributionAt: new Date().toISOString(),
            userEligible: false,
            userLastPurchaseAt: null,
            userWindowExpiresAt: null,
          }),
          getHistory: async () => [],
          getLifetimeTotal: async () => Credit.ZERO,
          getDigestTenantAggregates: async () => [],
          getTenantEmail: async () => undefined,
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
