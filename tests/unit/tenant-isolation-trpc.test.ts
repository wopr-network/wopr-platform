/**
 * tRPC TENANT ISOLATION TESTS — WOP-822
 *
 * Verifies that a tenant-scoped caller cannot access another tenant's data
 * via the tRPC billing and settings routers.
 *
 * Pattern: create two callers with different tenantId values, attempt cross-tenant
 * access, and assert that FORBIDDEN is thrown.
 *
 * Key finding:
 * - billing.usage, usageSummary: HAVE isolation check (pass)
 * - billing.creditsBalance, creditsHistory, creditsCheckout, portalSession:
 *   HAVE isolation check (pass) — check is `input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)`
 * - settings.*: use tenantProcedure — ctx.tenantId only, never user input → safe
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../src/test/db.js"
import type { DrizzleDb } from "../../src/db/index.js";
import type { ICreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { Credit } from "../../src/monetization/credit.js";
import { appRouter } from "../../src/trpc/index.js";
import type { TRPCContext } from "../../src/trpc/init.js";
import { setTrpcOrgMemberRepo } from "../../src/trpc/init.js";
import { setBillingRouterDeps } from "../../src/trpc/routers/billing.js";
import { setSettingsRouterDeps } from "../../src/trpc/routers/settings.js";

// ---------------------------------------------------------------------------
// Two test tenants
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-alpha";
const TENANT_B = "tenant-bravo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctxForTenant(tenantId: string): TRPCContext {
  return {
    user: { id: `user-${tenantId}`, roles: ["user"] },
    tenantId,
  };
}

// ---------------------------------------------------------------------------
// Wire org member repo (required by tenantProcedure / tRPC middleware)
// ---------------------------------------------------------------------------

beforeAll(() => {
  setTrpcOrgMemberRepo({
    findMember: async (_userId: string, orgId: string) => ({
      id: "m1",
      orgId,
      userId: `user-${orgId}`,
      role: "owner" as const,
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
    deleteAllMembers: async () => {},
    deleteAllInvites: async () => {},
  });
});

// ---------------------------------------------------------------------------
// Describe blocks
// ---------------------------------------------------------------------------

describe("tRPC tenant isolation — billing router (WOP-822)", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);

    const creditLedger: ICreditLedger = {
      credit(tenantId, amountCents) { return Promise.resolve({ id: "t", tenantId, amountCents, balanceAfterCents: 0, type: "signup_grant", description: null, referenceId: null, fundingSource: null, createdAt: new Date().toISOString() }); },
      debit(tenantId, amountCents) { return Promise.resolve({ id: "t", tenantId, amountCents: -amountCents, balanceAfterCents: 0, type: "correction", description: null, referenceId: null, fundingSource: null, createdAt: new Date().toISOString() }); },
      balance() { return Promise.resolve(Credit.ZERO); },
      hasReferenceId() { return Promise.resolve(false); },
      history() { return Promise.resolve([]); },
      tenantsWithBalance() { return Promise.resolve([]); },
    };
    const { MeterAggregator } = await import("../../src/monetization/metering/aggregator.js");
    const { DrizzleUsageSummaryRepository } = await import("../../src/monetization/metering/drizzle-usage-summary-repository.js");
    const meterAggregator = new MeterAggregator(new DrizzleUsageSummaryRepository(db));
    const { TenantCustomerRepository } = await import("../../src/monetization/stripe/tenant-store.js");
    const tenantRepo = new TenantCustomerRepository(db);
    setBillingRouterDeps({
      stripe: {
        checkout: { sessions: { create: () => Promise.resolve({ id: "cs_test", url: "https://checkout.stripe.com/test" }) } },
        billingPortal: { sessions: { create: () => Promise.resolve({ url: "https://billing.stripe.com/test" }) } },
      } as never,
      tenantRepo,
      creditLedger,
      meterAggregator,
      priceMap: undefined,
      dividendRepo: {
        getStats: () => Promise.resolve({ poolCents: 0, activeUsers: 0, perUserCents: 0, nextDistributionAt: new Date().toISOString(), userEligible: false, userLastPurchaseAt: null, userWindowExpiresAt: null }),
        getHistory: () => Promise.resolve([]),
        getLifetimeTotalCents: () => Promise.resolve(0),
      },
    });
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
  });

  // -------------------------------------------------------------------------
  // creditsBalance — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's creditsBalance", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    // Caller with tenantId=TENANT_A passes tenant=TENANT_B — should be FORBIDDEN
    await expect(callerA.billing.creditsBalance({ tenant: TENANT_B })).rejects.toThrow("Access denied");
  });

  it("tenant-scoped caller can read own creditsBalance", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.creditsBalance({ tenant: TENANT_A });
    expect(result.tenant).toBe(TENANT_A);
    expect(result.balance_credits).toBe(0);
  });

  it("tenant-scoped caller can omit tenant and get own creditsBalance via ctx", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.creditsBalance({});
    expect(result.tenant).toBe(TENANT_A);
  });

  // -------------------------------------------------------------------------
  // creditsHistory — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's creditsHistory", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.creditsHistory({ tenant: TENANT_B })).rejects.toThrow("Access denied");
  });

  it("tenant-scoped caller can read own creditsHistory", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.creditsHistory({ tenant: TENANT_A });
    expect(result.entries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // creditsCheckout — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot create checkout for other tenant", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(
      callerA.billing.creditsCheckout({
        tenant: TENANT_B,
        priceId: "price_test123",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toThrow("Access denied");
  });

  // -------------------------------------------------------------------------
  // portalSession — has isolation check
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot open portal session for other tenant", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(
      callerA.billing.portalSession({
        tenant: TENANT_B,
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("Access denied");
  });

  // -------------------------------------------------------------------------
  // usage — has isolation check (verifies existing protection)
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's usage (existing protection)", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.usage({ tenant: TENANT_B })).rejects.toThrow("Forbidden");
  });

  it("tenant-scoped caller can read own usage", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.billing.usage({ tenant: TENANT_A });
    expect(result.tenant).toBe(TENANT_A);
    expect(result.usage).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // usageSummary — has isolation check (verifies existing protection)
  // -------------------------------------------------------------------------

  it("tenant-scoped caller cannot read other tenant's usageSummary (existing protection)", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));

    await expect(callerA.billing.usageSummary({ tenant: TENANT_B })).rejects.toThrow("Forbidden");
  });

});

// ---------------------------------------------------------------------------
// Settings router — uses tenantProcedure (ctx.tenantId only)
// ---------------------------------------------------------------------------

describe("tRPC tenant isolation — settings router (WOP-822)", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
    const { NotificationPreferencesStore } = await import(
      "../../src/email/notification-preferences-store.js"
    );
    const notifStore = new NotificationPreferencesStore(db);

    setSettingsRouterDeps({ getNotificationPrefsStore: () => notifStore });
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
  });

  it("tenantConfig returns caller's own tenantId", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.settings.tenantConfig();
    expect(result.tenantId).toBe(TENANT_A);
  });

  it("tenantConfig for tenant B returns tenant B's id", async () => {
    const callerB = appRouter.createCaller(ctxForTenant(TENANT_B));
    const result = await callerB.settings.tenantConfig();
    expect(result.tenantId).toBe(TENANT_B);
  });

  it("ping returns caller's tenantId", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const result = await callerA.settings.ping();
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.ok).toBe(true);
  });

  it("notificationPreferences are scoped to caller's tenant", async () => {
    const callerA = appRouter.createCaller(ctxForTenant(TENANT_A));
    const callerB = appRouter.createCaller(ctxForTenant(TENANT_B));

    // Update prefs for A — disable billing_low_balance (default is true)
    await callerA.settings.updateNotificationPreferences({ billing_low_balance: false });

    // A sees their updated prefs
    const prefsA = await callerA.settings.notificationPreferences();
    expect(prefsA.billing_low_balance).toBe(false);

    // B sees their own default prefs — A's change must NOT bleed into B
    const prefsB = await callerB.settings.notificationPreferences();
    expect(prefsB.billing_low_balance).toBe(true); // B still has default true
  });

  it("tenantProcedure rejects caller with no tenantId", async () => {
    const caller = appRouter.createCaller({ user: { id: "u1", roles: ["user"] }, tenantId: undefined });
    await expect(caller.settings.ping()).rejects.toThrow("Tenant context required");
  });
});
