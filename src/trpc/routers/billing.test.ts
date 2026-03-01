import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAuditLogRepository } from "../../audit/audit-log-repository.js";
import { AuditLogger } from "../../audit/logger.js";
import type { AuditEntry } from "../../audit/schema.js";
import type { DrizzleDb } from "../../db/index.js";
import { DrizzleAffiliateRepository } from "../../monetization/affiliate/drizzle-affiliate-repository.js";
import { Credit } from "../../monetization/credit.js";
import { DrizzleAutoTopupSettingsRepository } from "../../monetization/credits/auto-topup-settings-repository.js";
import type { CreditTransaction, ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import type { IDividendRepository } from "../../monetization/credits/dividend-repository.js";
import { DrizzleSpendingLimitsRepository } from "../../monetization/drizzle-spending-limits-repository.js";
import type { IPaymentProcessor } from "../../monetization/payment-processor.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { type BillingRouterDeps, billingRouter, setBillingRouterDeps } from "./billing.js";

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function makeCtx(userId: string, tenantId?: string) {
  return {
    user: { id: userId, roles: [] as string[] },
    tenantId,
  };
}

function makeUnauthCtx() {
  return { user: undefined as undefined, tenantId: undefined as string | undefined };
}

function makeCaller(ctx: ReturnType<typeof makeCtx> | ReturnType<typeof makeUnauthCtx>) {
  return billingRouter.createCaller(ctx as Parameters<typeof billingRouter.createCaller>[0]);
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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
    listInvoices: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeMockLedger(): ICreditLedger {
  const balances = new Map<string, number>();
  const txns: CreditTransaction[] = [];
  return {
    async credit(tenantId, amount, type, description) {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) + cents);
      const tx: CreditTransaction = {
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
      const tx: CreditTransaction = {
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

function createMockAuditRepo(): IAuditLogRepository & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async insert(entry: AuditEntry) {
      entries.push(entry);
    },
    async query() {
      return [];
    },
    async count() {
      return 0;
    },
    async purgeOlderThan() {
      return 0;
    },
    async purgeOlderThanForUser() {
      return 0;
    },
    async countByAction() {
      return {};
    },
    async getTimeRange() {
      return { oldest: null, newest: null };
    },
  };
}

function makeMockDividendRepo(overrides: Partial<IDividendRepository> = {}): IDividendRepository {
  return {
    getStats: vi.fn().mockResolvedValue({
      pool: Credit.ZERO,
      activeUsers: 0,
      perUser: Credit.ZERO,
      nextDistributionAt: new Date().toISOString(),
      userEligible: false,
      userLastPurchaseAt: null,
      userWindowExpiresAt: null,
    }),
    getHistory: vi.fn().mockResolvedValue([]),
    getLifetimeTotal: vi.fn().mockResolvedValue(Credit.ZERO),
    getDigestTenantAggregates: vi.fn().mockResolvedValue([]),
    getTenantEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("billingRouter", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let affiliateRepo: DrizzleAffiliateRepository;
  let MeterAggregatorClass: new (
    db: DrizzleDb,
  ) => InstanceType<typeof import("../../monetization/metering/aggregator.js")["MeterAggregator"]>;
  let TenantCustomerStoreClass: new (
    db: DrizzleDb,
  ) => InstanceType<typeof import("../../monetization/index.js")["TenantCustomerStore"]>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    pool = testDb.pool;
    db = testDb.db;
    const agg = await import("../../monetization/metering/aggregator.js");
    MeterAggregatorClass = agg.MeterAggregator as typeof MeterAggregatorClass;
    const tcs = await import("../../monetization/index.js");
    TenantCustomerStoreClass = tcs.TenantCustomerStore as typeof TenantCustomerStoreClass;
  }, 30000);

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    affiliateRepo = new DrizzleAffiliateRepository(db);
  });

  function injectDeps(overrides: Partial<BillingRouterDeps> = {}) {
    const defaults: BillingRouterDeps = {
      processor: createMockProcessor(),
      tenantStore: new TenantCustomerStoreClass(db),
      creditLedger: makeMockLedger(),
      meterAggregator: new MeterAggregatorClass(db),
      priceMap: undefined,
      autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
      dividendRepo: makeMockDividendRepo(),
      spendingLimitsRepo: new DrizzleSpendingLimitsRepository(db),
      affiliateRepo,
      ...overrides,
    };
    setBillingRouterDeps(defaults);
    return defaults;
  }

  // -------------------------------------------------------------------------
  // creditsCheckout
  // -------------------------------------------------------------------------

  describe("creditsCheckout", () => {
    beforeEach(() => {
      injectDeps();
    });

    it("returns checkout URL and sessionId", async () => {
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.creditsCheckout({
        priceId: "price_test_5",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
      expect(result.url).toBe("https://pay.example.com/checkout/cs_test");
      expect(result.sessionId).toBe("cs_test");
    });

    it("uses ctx.tenantId when tenant omitted", async () => {
      const mockProcessor = createMockProcessor();
      injectDeps({ processor: mockProcessor });
      const caller = makeCaller(makeCtx("user-1", "ctx-tenant"));
      await caller.creditsCheckout({
        priceId: "price_test_5",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
      expect(mockProcessor.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: "ctx-tenant" }),
      );
    });

    it("rejects cross-tenant access", async () => {
      const caller = makeCaller(makeCtx("user-1", "tenant-a"));
      await expect(
        caller.creditsCheckout({
          tenant: "tenant-b",
          priceId: "price_test_5",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
      ).rejects.toThrow("Access denied");
    });

    it("rejects unauthenticated request", async () => {
      const caller = makeCaller(makeUnauthCtx());
      await expect(
        caller.creditsCheckout({
          priceId: "price_test_5",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
      ).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // cryptoCheckout
  // -------------------------------------------------------------------------

  describe("cryptoCheckout", () => {
    it("throws NOT_IMPLEMENTED when payram not configured", async () => {
      injectDeps({ payramClient: undefined, payramChargeStore: undefined });
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      await expect(caller.cryptoCheckout({ amountUsd: 10 })).rejects.toThrow("Crypto payments not configured");
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.cryptoCheckout({ amountUsd: 10 })).rejects.toThrow("Authentication required");
    });

    it("rejects amount below minimum", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      // MIN_PAYMENT_USD is 10; amount 0.01 fails zod validation
      await expect(caller.cryptoCheckout({ amountUsd: 0.01 })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // dividendStats
  // -------------------------------------------------------------------------

  describe("dividendStats", () => {
    it("returns stats shape with defaults", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.dividendStats({});
      expect(result).toHaveProperty("pool_cents");
      expect(result).toHaveProperty("active_users");
      expect(result).toHaveProperty("per_user_cents");
      expect(result).toHaveProperty("next_distribution_at");
      expect(result).toHaveProperty("user_eligible");
      expect(result.pool_cents).toBe(0);
      expect(result.active_users).toBe(0);
      expect(result.user_eligible).toBe(false);
    });

    it("uses ctx.tenantId when tenant omitted", async () => {
      const dividendRepo = makeMockDividendRepo();
      injectDeps({ dividendRepo });
      const caller = makeCaller(makeCtx("user-1", "my-tenant"));
      await caller.dividendStats();
      expect(dividendRepo.getStats).toHaveBeenCalledWith("my-tenant");
    });

    it("rejects cross-tenant access", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-a"));
      await expect(caller.dividendStats({ tenant: "tenant-b" })).rejects.toThrow("Access denied");
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.dividendStats()).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // dividendHistory
  // -------------------------------------------------------------------------

  describe("dividendHistory", () => {
    it("returns empty array by default", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.dividendHistory({});
      expect(result.dividends).toEqual([]);
    });

    it("passes limit and offset to repo", async () => {
      const dividendRepo = makeMockDividendRepo();
      injectDeps({ dividendRepo });
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      await caller.dividendHistory({ limit: 10, offset: 5 });
      expect(dividendRepo.getHistory).toHaveBeenCalledWith("tenant-1", 10, 5);
    });

    it("rejects cross-tenant access", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-a"));
      await expect(caller.dividendHistory({ tenant: "tenant-b" })).rejects.toThrow("Access denied");
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.dividendHistory()).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // dividendLifetime
  // -------------------------------------------------------------------------

  describe("dividendLifetime", () => {
    it("returns zero for new tenant", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.dividendLifetime({});
      expect(result.total_cents).toBe(0);
      expect(result.tenant).toBe("tenant-1");
    });

    it("returns value from repo", async () => {
      const dividendRepo = makeMockDividendRepo({
        getLifetimeTotal: vi.fn().mockResolvedValue(Credit.fromCents(4200)),
      });
      injectDeps({ dividendRepo });
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.dividendLifetime({});
      expect(result.total_cents).toBe(4200);
    });

    it("rejects cross-tenant access", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-a"));
      await expect(caller.dividendLifetime({ tenant: "tenant-b" })).rejects.toThrow("Access denied");
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.dividendLifetime()).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // affiliateInfo
  // -------------------------------------------------------------------------

  describe("affiliateInfo", () => {
    it("returns stats from affiliate repo", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.affiliateInfo();
      expect(result).toBeDefined();
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.affiliateInfo()).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // affiliateRecordReferral
  // -------------------------------------------------------------------------

  describe("affiliateRecordReferral", () => {
    it("rejects when caller tenant does not match referredTenantId", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-a"));
      await expect(caller.affiliateRecordReferral({ code: "abc123", referredTenantId: "tenant-b" })).rejects.toThrow(
        "Cannot record referral for another tenant",
      );
    });

    it("rejects invalid referral code", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "user-1"));
      await expect(caller.affiliateRecordReferral({ code: "nonexist", referredTenantId: "user-1" })).rejects.toThrow(
        "Invalid referral code",
      );
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.affiliateRecordReferral({ code: "abc123", referredTenantId: "t1" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // -------------------------------------------------------------------------
  // memberUsage
  // -------------------------------------------------------------------------

  describe("memberUsage", () => {
    it("returns tenant and members for new tenant", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-1"));
      const result = await caller.memberUsage({});
      expect(result.tenant).toBe("tenant-1");
      expect(Array.isArray(result.members)).toBe(true);
    });

    it("uses ctx.tenantId when tenant omitted", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "my-tenant"));
      const result = await caller.memberUsage();
      expect(result.tenant).toBe("my-tenant");
    });

    it("rejects cross-tenant access", async () => {
      injectDeps();
      const caller = makeCaller(makeCtx("user-1", "tenant-a"));
      await expect(caller.memberUsage({ tenant: "tenant-b" })).rejects.toThrow("Access denied");
    });

    it("rejects unauthenticated request", async () => {
      injectDeps();
      const caller = makeCaller(makeUnauthCtx());
      await expect(caller.memberUsage()).rejects.toThrow("Authentication required");
    });
  });

  // -------------------------------------------------------------------------
  // billingInfo
  // -------------------------------------------------------------------------

  describe("billingInfo", () => {
    it("returns email from processor.getCustomerEmail", async () => {
      const mockProcessor = createMockProcessor({
        getCustomerEmail: vi.fn().mockResolvedValue("billing@test.com"),
        listPaymentMethods: vi.fn().mockResolvedValue([]),
      });
      injectDeps({ processor: mockProcessor });

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.billingInfo();
      expect(result.email).toBe("billing@test.com");
      expect(mockProcessor.getCustomerEmail).toHaveBeenCalledWith("user-1");
    });
  });

  // -------------------------------------------------------------------------
  // updateBillingEmail
  // -------------------------------------------------------------------------

  describe("updateBillingEmail", () => {
    it("persists email via processor.updateCustomerEmail", async () => {
      const mockProcessor = createMockProcessor({
        updateCustomerEmail: vi.fn().mockResolvedValue(undefined),
      });
      const mockTenantStore = {
        getByTenant: vi.fn().mockResolvedValue({ tenant: "user-1", processor_customer_id: "cus_abc" }),
        getByProcessorCustomerId: vi.fn(),
        upsert: vi.fn(),
        setTier: vi.fn(),
        setBillingHold: vi.fn(),
        hasBillingHold: vi.fn(),
        getInferenceMode: vi.fn(),
        setInferenceMode: vi.fn(),
        list: vi.fn(),
        buildCustomerIdMap: vi.fn(),
      };
      injectDeps({
        processor: mockProcessor,
        tenantStore: mockTenantStore as unknown as BillingRouterDeps["tenantStore"],
      });

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.updateBillingEmail({ email: "new@test.com" });
      expect(result.email).toBe("new@test.com");
      expect(mockProcessor.updateCustomerEmail).toHaveBeenCalledWith("user-1", "new@test.com");
    });
  });

  // -------------------------------------------------------------------------
  // Auth enforcement sweep — all protected procedures
  // -------------------------------------------------------------------------

  describe("auth enforcement", () => {
    beforeEach(() => {
      injectDeps();
    });

    const protectedQueries: Array<{ name: string; input: unknown }> = [
      { name: "creditsBalance", input: {} },
      { name: "creditsHistory", input: {} },
      { name: "usage", input: {} },
      { name: "usageSummary", input: {} },
      { name: "plans", input: undefined },
      { name: "currentPlan", input: undefined },
      { name: "inferenceMode", input: undefined },
      { name: "providerCosts", input: undefined },
      { name: "hostedUsageSummary", input: undefined },
      { name: "hostedUsageEvents", input: undefined },
      { name: "spendingLimits", input: undefined },
      { name: "billingInfo", input: undefined },
      { name: "autoTopupSettings", input: undefined },
      { name: "dividendStats", input: undefined },
      { name: "dividendHistory", input: undefined },
      { name: "dividendLifetime", input: undefined },
      { name: "affiliateInfo", input: undefined },
      { name: "memberUsage", input: undefined },
    ];

    const protectedMutations: Array<{ name: string; input: unknown }> = [
      {
        name: "creditsCheckout",
        input: { priceId: "p", successUrl: "https://a.com", cancelUrl: "https://b.com" },
      },
      { name: "cryptoCheckout", input: { amountUsd: 10 } },
      { name: "portalSession", input: { returnUrl: "https://a.com" } },
      {
        name: "updateSpendingLimits",
        input: { global: { alertAt: null, hardCap: null }, perCapability: {} },
      },
      { name: "updateBillingEmail", input: { email: "a@b.com" } },
      { name: "removePaymentMethod", input: { id: "pm_1" } },
      { name: "updateAutoTopupSettings", input: {} },
      { name: "changePlan", input: { tier: "free" as const } },
      { name: "setInferenceMode", input: { mode: "byok" as const } },
      { name: "affiliateRecordReferral", input: { code: "abc12", referredTenantId: "t1" } },
    ];

    for (const { name, input } of protectedQueries) {
      it(`${name} rejects unauthenticated`, async () => {
        const caller = makeCaller(makeUnauthCtx());
        await expect((caller as Record<string, (i: unknown) => Promise<unknown>>)[name](input)).rejects.toThrow(
          "Authentication required",
        );
      });
    }

    for (const { name, input } of protectedMutations) {
      it(`${name} rejects unauthenticated`, async () => {
        const caller = makeCaller(makeUnauthCtx());
        await expect((caller as Record<string, (i: unknown) => Promise<unknown>>)[name](input)).rejects.toThrow(
          "Authentication required",
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // updateAutoTopupSettings audit log
  // -------------------------------------------------------------------------

  describe("updateAutoTopupSettings audit log", () => {
    let auditRepo: ReturnType<typeof createMockAuditRepo>;

    beforeEach(() => {
      auditRepo = createMockAuditRepo();
      injectDeps({
        processor: createMockProcessor({ listPaymentMethods: vi.fn().mockResolvedValue([{ id: "pm_1" }]) }),
        auditLogger: new AuditLogger(auditRepo),
      });
    });

    it("emits audit entry with previous and new settings", async () => {
      const caller = makeCaller(makeCtx("user-audit-1"));

      // First call — creates settings (previous is null)
      await caller.updateAutoTopupSettings({
        usage_enabled: true,
        usage_threshold_cents: 500,
        usage_topup_cents: 2000,
      });

      expect(auditRepo.entries).toHaveLength(1);
      const entry1 = auditRepo.entries[0];
      expect(entry1?.action).toBe("billing.auto_topup_update");
      expect(entry1?.resource_type).toBe("billing");
      expect(entry1?.user_id).toBe("user-audit-1");
      const details1 = JSON.parse(entry1?.details ?? "null");
      expect(details1.previous).toBeNull();
      expect(details1.new.usage_enabled).toBe(true);

      // Second call — updates settings (previous is non-null)
      await caller.updateAutoTopupSettings({
        usage_enabled: false,
      });

      expect(auditRepo.entries).toHaveLength(2);
      const entry2 = auditRepo.entries[1];
      const details2 = JSON.parse(entry2?.details ?? "null");
      expect(details2.previous.usage_enabled).toBe(true);
      expect(details2.new.usage_enabled).toBe(false);
    });

    it("does not break settings update if audit logging fails", async () => {
      const failingRepo: IAuditLogRepository = {
        async insert() {
          throw new Error("audit DB down");
        },
        async query() {
          return [];
        },
        async count() {
          return 0;
        },
        async purgeOlderThan() {
          return 0;
        },
        async purgeOlderThanForUser() {
          return 0;
        },
        async countByAction() {
          return {};
        },
        async getTimeRange() {
          return { oldest: null, newest: null };
        },
      };
      injectDeps({
        processor: createMockProcessor({ listPaymentMethods: vi.fn().mockResolvedValue([{ id: "pm_1" }]) }),
        auditLogger: new AuditLogger(failingRepo),
      });

      const caller = makeCaller(makeCtx("user-audit-2"));

      // Should NOT throw even though audit fails
      const result = await caller.updateAutoTopupSettings({
        usage_enabled: true,
        usage_threshold_cents: 500,
        usage_topup_cents: 2000,
      });

      expect(result.usage_enabled).toBe(true);
    });
  });
});
