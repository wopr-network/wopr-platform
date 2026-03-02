/**
 * Tenant isolation tests for the billing tRPC router (WOP-1406).
 *
 * Verifies that an authenticated user from tenant-alpha cannot access
 * billing data belonging to tenant-bravo by manipulating the x-tenant-id header.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { Credit } from "../../monetization/credit.js";
import type { CreditTransaction, ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import type { IDividendRepository } from "../../monetization/credits/dividend-repository.js";
import type { IPaymentProcessor } from "../../monetization/payment-processor.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { setTrpcOrgMemberRepo } from "../init.js";
import { type BillingRouterDeps, billingRouter, setBillingRouterDeps } from "./billing.js";

// ---------------------------------------------------------------------------
// Restrictive org member repo: only allows user-<orgId> to access <orgId>
// ---------------------------------------------------------------------------

beforeAll(() => {
  setTrpcOrgMemberRepo({
    findMember: async (orgId: string, userId: string) => {
      // Only allow access if the userId is the "owner" of that org
      if (userId === `user-${orgId}`) {
        return {
          id: "m1",
          orgId,
          userId,
          role: "owner" as const,
          joinedAt: Date.now(),
        };
      }
      return null; // Cross-tenant: not a member
    },
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
    deleteAllMembers: async () => {},
    deleteAllInvites: async () => {},
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(userId: string, tenantId: string) {
  return {
    user: { id: userId, roles: [] as string[] },
    tenantId,
  };
}

function makeCaller(ctx: ReturnType<typeof makeCtx>) {
  return billingRouter.createCaller(ctx as Parameters<typeof billingRouter.createCaller>[0]);
}

function createMockProcessor(): IPaymentProcessor {
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
  };
}

function makeMockLedger(): ICreditLedger {
  return {
    async credit() {
      return {} as CreditTransaction;
    },
    async debit() {
      return {} as CreditTransaction;
    },
    async balance() {
      return Credit.ZERO;
    },
    async hasReferenceId() {
      return false;
    },
    async history() {
      return [];
    },
    async tenantsWithBalance() {
      return [];
    },
    async expiredCredits() {
      return [];
    },
    async memberUsage() {
      return [];
    },
  };
}

function makeMockDividendRepo(): IDividendRepository {
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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("billing tenant isolation (WOP-1406)", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  }, 30000);

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);

    const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
    const { TenantCustomerStore } = await import("../../monetization/index.js");
    const { DrizzleAutoTopupSettingsRepository } = await import(
      "../../monetization/credits/auto-topup-settings-repository.js"
    );
    const { DrizzleSpendingLimitsRepository } = await import(
      "../../monetization/drizzle-spending-limits-repository.js"
    );
    const { DrizzleAffiliateRepository } = await import("../../monetization/affiliate/drizzle-affiliate-repository.js");

    const deps: BillingRouterDeps = {
      processor: createMockProcessor(),
      tenantStore: new TenantCustomerStore(db),
      creditLedger: makeMockLedger(),
      meterAggregator: new MeterAggregator(db),
      priceMap: undefined,
      autoTopupSettingsStore: new DrizzleAutoTopupSettingsRepository(db),
      dividendRepo: makeMockDividendRepo(),
      spendingLimitsRepo: new DrizzleSpendingLimitsRepository(db),
      affiliateRepo: new DrizzleAffiliateRepository(db),
    };
    setBillingRouterDeps(deps);
  });

  // Attacker: authenticated as user-tenant-alpha, but claims to be tenant-bravo
  // Since user-tenant-alpha !== user-tenant-bravo, findMember returns null → FORBIDDEN
  const attackerCtx = makeCtx("user-tenant-alpha", "tenant-bravo");

  // Queries that must reject cross-tenant access
  const crossTenantQueries: Array<{ name: string; input?: unknown }> = [
    { name: "currentPlan" },
    { name: "inferenceMode" },
    { name: "hostedUsageSummary" },
    { name: "hostedUsageEvents" },
    { name: "spendingLimits" },
    { name: "billingInfo" },
    { name: "autoTopupSettings" },
    { name: "usage", input: {} },
    { name: "usageSummary", input: {} },
    { name: "affiliateInfo" },
    { name: "providerCosts" },
    { name: "memberUsage" },
    { name: "dividendStats" },
    { name: "dividendHistory" },
    { name: "dividendLifetime" },
  ];

  // Mutations that must reject cross-tenant access
  const crossTenantMutations: Array<{ name: string; input: unknown }> = [
    { name: "changePlan", input: { tier: "free" } },
    { name: "setInferenceMode", input: { mode: "byok" } },
    {
      name: "updateSpendingLimits",
      input: { global: { alertAt: null, hardCap: null }, perCapability: {} },
    },
    { name: "updateBillingEmail", input: { email: "evil@attacker.com" } },
    { name: "removePaymentMethod", input: { id: "pm_1" } },
    { name: "updateAutoTopupSettings", input: {} },
    {
      name: "creditsCheckout",
      input: { priceId: "p", successUrl: "https://app.wopr.bot/a", cancelUrl: "https://app.wopr.bot/b" },
    },
    { name: "cryptoCheckout", input: { amountUsd: 10 } },
    { name: "portalSession", input: { returnUrl: "https://app.wopr.bot/a" } },
    { name: "applyCoupon", input: { code: "FREE100" } },
  ];

  for (const { name, input } of crossTenantQueries) {
    it(`${name} rejects cross-tenant access`, async () => {
      const caller = makeCaller(attackerCtx);
      await expect((caller as Record<string, (i: unknown) => Promise<unknown>>)[name](input)).rejects.toThrow(
        /Not authorized for this tenant|Tenant context required/,
      );
    });
  }

  for (const { name, input } of crossTenantMutations) {
    it(`${name} rejects cross-tenant access`, async () => {
      const caller = makeCaller(attackerCtx);
      await expect((caller as Record<string, (i: unknown) => Promise<unknown>>)[name](input)).rejects.toThrow(
        /Not authorized for this tenant|Tenant context required/,
      );
    });
  }

  it("allows legitimate tenant to access their own data", async () => {
    // user-tenant-alpha accessing their own tenant (tenant-alpha)
    // validateTenantAccess: tenantId === userId? No ("tenant-alpha" !== "user-tenant-alpha")
    // findMember("tenant-alpha", "user-tenant-alpha") → returns member (matches user-<orgId> pattern)
    const legitimateCtx = makeCtx("user-tenant-alpha", "tenant-alpha");
    const caller = makeCaller(legitimateCtx);
    const result = await caller.currentPlan();
    expect(result).toHaveProperty("tier");
  });
});
