/**
 * Tests for billing.applyCoupon — happy path, expired/invalid code, already-redeemed.
 * Uses a mock PromotionEngine (no PGlite needed).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromotionEngine } from "../../../monetization/promotions/engine.js";
import { appRouter } from "../../index.js";
import { setTrpcOrgMemberRepo } from "../../init.js";
import { type BillingRouterDeps, setBillingRouterDeps } from "../billing.js";

// ---------------------------------------------------------------------------
// Helpers — token-prefixed userId bypasses validateTenantAccess
// ---------------------------------------------------------------------------

function tenantCtx(tenantId = "tenant-1") {
  return {
    user: { id: "token:test-user", roles: [] as string[] },
    tenantId,
  };
}

function unauthCtx() {
  return { user: undefined as undefined, tenantId: undefined as string | undefined };
}

// ---------------------------------------------------------------------------
// Minimal mock deps factory
// ---------------------------------------------------------------------------

function makeMockEngine(overrides: Partial<PromotionEngine> = {}): PromotionEngine {
  return {
    evaluateAndGrant: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PromotionEngine;
}

function makeMinimalDeps(overrides: Partial<BillingRouterDeps> = {}): BillingRouterDeps {
  return {
    processor: {
      name: "mock",
      supportsPortal: () => false,
      createCheckoutSession: vi.fn(),
      createPortalSession: vi.fn(),
      handleWebhook: vi.fn(),
      setupPaymentMethod: vi.fn(),
      listPaymentMethods: vi.fn(),
      detachPaymentMethod: vi.fn(),
      charge: vi.fn(),
      getCustomerEmail: vi.fn(),
      updateCustomerEmail: vi.fn(),
      listInvoices: vi.fn(),
    } as unknown as BillingRouterDeps["processor"],
    tenantRepo: {
      getOrCreate: vi.fn(),
      get: vi.fn(),
      updateStripeCustomerId: vi.fn(),
    } as unknown as BillingRouterDeps["tenantRepo"],
    creditLedger: {
      credit: vi.fn(),
      debit: vi.fn(),
      balance: vi.fn(),
      hasReferenceId: vi.fn(),
      history: vi.fn(),
      tenantsWithBalance: vi.fn(),
      expiredCredits: vi.fn(),
      memberUsage: vi.fn(),
      lifetimeSpend: vi.fn(),
    } as unknown as BillingRouterDeps["creditLedger"],
    meterAggregator: {
      getByTenant: vi.fn(),
      getTenantTotal: vi.fn(),
    } as unknown as BillingRouterDeps["meterAggregator"],
    priceMap: undefined,
    autoTopupSettingsStore: {
      get: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    } as unknown as BillingRouterDeps["autoTopupSettingsStore"],
    dividendRepo: {
      getStats: vi.fn(),
      getHistory: vi.fn(),
      getLifetimeTotal: vi.fn(),
      getDigestTenantAggregates: vi.fn(),
      getTenantEmail: vi.fn(),
    } as unknown as BillingRouterDeps["dividendRepo"],
    spendingLimitsRepo: {
      get: vi.fn(),
      upsert: vi.fn(),
    } as unknown as BillingRouterDeps["spendingLimitsRepo"],
    affiliateRepo: {
      getByTenant: vi.fn(),
      upsert: vi.fn(),
      listPending: vi.fn(),
      markPaid: vi.fn(),
    } as unknown as BillingRouterDeps["affiliateRepo"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wire org member repo so tenantProcedure doesn't throw on non-token users
// ---------------------------------------------------------------------------

beforeEach(() => {
  setTrpcOrgMemberRepo({
    findMember: async (_orgId, _userId) => ({
      id: "m1",
      orgId: _orgId,
      userId: _userId,
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
// billing.applyCoupon — happy path
// ---------------------------------------------------------------------------

describe("billing.applyCoupon — happy path", () => {
  let engine: PromotionEngine;

  beforeEach(() => {
    engine = makeMockEngine();
    setBillingRouterDeps(makeMinimalDeps({ promotionEngine: engine }));
  });

  it("returns creditsGranted when promotion engine grants credits", async () => {
    const { Credit } = await import("../../../monetization/credit.js");
    vi.mocked(engine.evaluateAndGrant).mockResolvedValue([
      {
        promotionId: "promo-1",
        promotionName: "Launch Promo",
        creditsGranted: Credit.fromCents(500),
        transactionId: "tx-abc",
      },
    ]);

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    const result = await caller.billing.applyCoupon({ code: "LAUNCH50" });

    expect(result.creditsGranted).toBe(500);
    expect(result.message).toContain("500");
  });

  it("normalizes coupon code to uppercase before calling engine", async () => {
    const { Credit } = await import("../../../monetization/credit.js");
    vi.mocked(engine.evaluateAndGrant).mockResolvedValue([
      {
        promotionId: "promo-1",
        promotionName: "Test",
        creditsGranted: Credit.fromCents(100),
        transactionId: "tx-1",
      },
    ]);

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await caller.billing.applyCoupon({ code: "launch50" });

    expect(engine.evaluateAndGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        couponCode: "LAUNCH50",
        trigger: "coupon_redeem",
        tenantId: "tenant-1",
      }),
    );
  });

  it("trims whitespace from coupon code before calling engine", async () => {
    const { Credit } = await import("../../../monetization/credit.js");
    vi.mocked(engine.evaluateAndGrant).mockResolvedValue([
      {
        promotionId: "promo-1",
        promotionName: "Test",
        creditsGranted: Credit.fromCents(100),
        transactionId: "tx-1",
      },
    ]);

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await caller.billing.applyCoupon({ code: "  CODE123  " });

    expect(engine.evaluateAndGrant).toHaveBeenCalledWith(expect.objectContaining({ couponCode: "CODE123" }));
  });

  it("sums credits across multiple granted promotions", async () => {
    const { Credit } = await import("../../../monetization/credit.js");
    vi.mocked(engine.evaluateAndGrant).mockResolvedValue([
      {
        promotionId: "promo-1",
        promotionName: "Promo A",
        creditsGranted: Credit.fromCents(300),
        transactionId: "tx-1",
      },
      {
        promotionId: "promo-2",
        promotionName: "Promo B",
        creditsGranted: Credit.fromCents(200),
        transactionId: "tx-2",
      },
    ]);

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    const result = await caller.billing.applyCoupon({ code: "MULTI" });

    expect(result.creditsGranted).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// billing.applyCoupon — error paths
// ---------------------------------------------------------------------------

describe("billing.applyCoupon — expired or invalid code", () => {
  let engine: PromotionEngine;

  beforeEach(() => {
    engine = makeMockEngine();
    setBillingRouterDeps(makeMinimalDeps({ promotionEngine: engine }));
  });

  it("throws BAD_REQUEST when engine returns empty results (invalid/expired code)", async () => {
    vi.mocked(engine.evaluateAndGrant).mockResolvedValue([]);

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await expect(caller.billing.applyCoupon({ code: "EXPIRED99" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("expired"),
    });
  });

  it("throws BAD_REQUEST when engine throws (engine-level validation failure)", async () => {
    vi.mocked(engine.evaluateAndGrant).mockRejectedValue(new Error("Coupon not found"));

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await expect(caller.billing.applyCoupon({ code: "BADCODE" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Invalid or expired"),
    });
  });
});

describe("billing.applyCoupon — already-redeemed code", () => {
  let engine: PromotionEngine;

  beforeEach(() => {
    engine = makeMockEngine();
    setBillingRouterDeps(makeMinimalDeps({ promotionEngine: engine }));
  });

  it("throws BAD_REQUEST when engine returns empty results for already-used code", async () => {
    // Engine returns [] when the coupon has already been redeemed by this tenant
    vi.mocked(engine.evaluateAndGrant).mockResolvedValue([]);

    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await expect(caller.billing.applyCoupon({ code: "USED123" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("already-used"),
    });
  });
});

describe("billing.applyCoupon — promotion engine not initialized", () => {
  beforeEach(() => {
    // No promotionEngine in deps
    setBillingRouterDeps(makeMinimalDeps({ promotionEngine: undefined }));
  });

  it("throws INTERNAL_SERVER_ERROR when promotion engine is not wired", async () => {
    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await expect(caller.billing.applyCoupon({ code: "ANY" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});

describe("billing.applyCoupon — input validation", () => {
  beforeEach(() => {
    const engine = makeMockEngine();
    setBillingRouterDeps(makeMinimalDeps({ promotionEngine: engine }));
  });

  it("rejects an empty code string", async () => {
    const caller = appRouter.createCaller(tenantCtx("tenant-1"));
    await expect(caller.billing.applyCoupon({ code: "" })).rejects.toThrow();
  });

  it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(unauthCtx());
    await expect(caller.billing.applyCoupon({ code: "CODE" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
