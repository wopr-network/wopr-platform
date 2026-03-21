/**
 * Tenant isolation tests for the billing tRPC router (WOP-1406).
 *
 * Verifies that an authenticated user from tenant-alpha cannot access
 * billing data belonging to tenant-bravo by manipulating the x-tenant-id header.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { IPaymentProcessor } from "@wopr-network/platform-core/billing";
import type { ILedger, JournalEntry } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import type { IDividendRepository } from "@wopr-network/platform-core/monetization/credits/dividend-repository";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    listOrgsByUser: async () => [],
    markInviteAccepted: async () => {},
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
    setDefaultPaymentMethod: vi.fn().mockResolvedValue(undefined),
    listInvoices: vi.fn().mockResolvedValue([]),
  };
}

function makeMockLedger(): ILedger {
  return {
    async credit() {
      return {} as JournalEntry;
    },
    async debit() {
      return {} as JournalEntry;
    },
    async debitCapped(_tenantId, _amount, _type, _opts?) {
      return {} as JournalEntry;
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
    async lifetimeSpend() {
      return Credit.fromCents(0);
    },
    async lifetimeSpendBatch(tenantIds: string[]) {
      return new Map(tenantIds.map((id) => [id, Credit.fromCents(0)]));
    },
    async post() {
      throw new Error("not implemented");
    },
    async trialBalance() {
      return { totalDebits: Credit.ZERO, totalCredits: Credit.ZERO, balanced: true, difference: Credit.ZERO };
    },
    async accountBalance() {
      return Credit.ZERO;
    },
    async seedSystemAccounts() {},
    async existsByReferenceIdLike() {
      return false;
    },
    async sumPurchasesForPeriod() {
      return Credit.ZERO;
    },
    async getActiveTenantIdsInWindow() {
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

    const { MeterAggregator, DrizzleUsageSummaryRepository } = await import("@wopr-network/platform-core/metering");
    const { TenantCustomerRepository } = await import("@wopr-network/platform-core/monetization/index");
    const { DrizzleAutoTopupSettingsRepository } = await import("@wopr-network/platform-core/credits");
    const { DrizzleSpendingLimitsRepository } = await import(
      "@wopr-network/platform-core/monetization/drizzle-spending-limits-repository"
    );
    const { DrizzleAffiliateRepository } = await import(
      "@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository"
    );

    const deps: BillingRouterDeps = {
      processor: createMockProcessor(),
      tenantRepo: new TenantCustomerRepository(db),
      creditLedger: makeMockLedger(),
      meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
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
    { name: "chargeStatus", input: { referenceId: "charge-other-tenant" } },
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
    { name: "checkout", input: { chain: "btc", amountUsd: 10 } },
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

  it("rejects session-cookie user claiming another user's personal tenant (WOP-1706)", async () => {
    // Simulates: attacker sets wopr_tenant_id cookie to victim's user ID.
    // The x-tenant-id header carries that value to createTRPCContext.
    // tenantProcedure must reject because attacker is not the victim.
    const caller = makeCaller(makeCtx("attacker-user", "victim-user"));

    await expect(caller.creditsBalance()).rejects.toThrow(/Not authorized for this tenant/);
  });

  it("rejects session-cookie user claiming an org they do not belong to (WOP-1706)", async () => {
    // Simulates: attacker sets wopr_tenant_id cookie to an org ID they're not a member of.
    const caller = makeCaller(makeCtx("attacker-user", "org-secret"));

    await expect(caller.creditsBalance()).rejects.toThrow(/Not authorized for this tenant/);
  });

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
