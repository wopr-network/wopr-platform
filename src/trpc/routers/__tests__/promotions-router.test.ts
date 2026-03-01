import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterRateOverride,
  AdapterRateOverrideCache,
} from "../../../monetization/adapters/rate-override-repository.js";
import type { Promotion } from "../../../monetization/promotions/promotion-repository.js";
import { appRouter } from "../../index.js";
import { setPromotionsRouterDeps } from "../promotions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminCtx() {
  return {
    user: { id: "admin-1", roles: ["platform_admin"] },
    tenantId: "t-1",
  };
}

function memberCtx() {
  return {
    user: { id: "user-1", roles: ["member"] },
    tenantId: "t-1",
  };
}

function unauthCtx() {
  return { user: undefined as undefined, tenantId: undefined as string | undefined };
}

function fakePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: "promo-1",
    name: "Test Promo",
    type: "coupon_fixed",
    status: "draft",
    startsAt: null,
    endsAt: null,
    valueType: "flat_credits",
    valueAmount: 100,
    maxValueCredits: null,
    firstPurchaseOnly: false,
    minPurchaseCredits: null,
    userSegment: "all",
    eligibleTenantIds: null,
    totalUseLimit: null,
    perUserLimit: 1,
    budgetCredits: null,
    totalUses: 0,
    totalCreditsGranted: 0,
    couponCode: null,
    couponBatchId: null,
    createdBy: "admin-1",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    notes: null,
    ...overrides,
  };
}

function fakeRateOverride(overrides: Partial<AdapterRateOverride> = {}): AdapterRateOverride {
  return {
    id: "ro-1",
    adapterId: "openai-gpt4",
    name: "Holiday Sale",
    discountPercent: 20,
    startsAt: new Date("2025-01-01"),
    endsAt: null,
    status: "active",
    createdBy: "admin-1",
    createdAt: new Date("2025-01-01"),
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock repos
// ---------------------------------------------------------------------------

function createMockDeps() {
  const promotionRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    listActive: vi.fn(),
    findByCouponCode: vi.fn(),
    updateStatus: vi.fn(),
    update: vi.fn(),
    incrementUsage: vi.fn(),
    incrementUsageIfBudgetAllows: vi.fn(),
    incrementUsageIfAllowed: vi.fn(),
  };
  const couponRepo = {
    createBatch: vi.fn(),
    findByCode: vi.fn(),
    redeem: vi.fn(),
    listByPromotion: vi.fn(),
    countRedeemed: vi.fn(),
    getUserRedemptionCount: vi.fn(),
  };
  const redemptionRepo = {
    create: vi.fn(),
    listByPromotion: vi.fn(),
    countByTenant: vi.fn(),
    hasPriorPurchase: vi.fn(),
  };
  const rateOverrideRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    findActiveForAdapter: vi.fn(),
    updateStatus: vi.fn(),
  };
  const rateOverrideCacheMock = {
    getDiscountPercent: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
  };
  const rateOverrideCache = rateOverrideCacheMock as unknown as AdapterRateOverrideCache;
  return { promotionRepo, couponRepo, redemptionRepo, rateOverrideRepo, rateOverrideCache, rateOverrideCacheMock };
}

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------

describe("promotions router — auth guards", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("rejects unauthenticated users on promotions.list with UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(unauthCtx());
    await expect(caller.promotions.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects non-admin users on promotions.list with FORBIDDEN", async () => {
    const caller = appRouter.createCaller(memberCtx());
    await expect(caller.promotions.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated users on promotions.create with UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(unauthCtx());
    await expect(
      caller.promotions.create({
        name: "X",
        type: "coupon_fixed",
        valueType: "flat_credits",
        valueAmount: 10,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects non-admin users on promotions.create with FORBIDDEN", async () => {
    const caller = appRouter.createCaller(memberCtx());
    await expect(
      caller.promotions.create({
        name: "X",
        type: "coupon_fixed",
        valueType: "flat_credits",
        valueAmount: 10,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects non-admin users on rateOverrides.list with FORBIDDEN", async () => {
    const caller = appRouter.createCaller(memberCtx());
    await expect(caller.rateOverrides.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated users on rateOverrides.create with UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(unauthCtx());
    await expect(
      caller.rateOverrides.create({
        adapterId: "x",
        name: "y",
        discountPercent: 10,
        startsAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ---------------------------------------------------------------------------
// promotions.list
// ---------------------------------------------------------------------------

describe("promotions.list", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("returns results from promotionRepo.list", async () => {
    const promos = [fakePromotion(), fakePromotion({ id: "promo-2", name: "Second" })];
    deps.promotionRepo.list.mockResolvedValue(promos);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.promotions.list({});

    expect(deps.promotionRepo.list).toHaveBeenCalledWith({ status: undefined, type: undefined });
    expect(result).toEqual(promos);
  });

  it("passes status and type filters to repo", async () => {
    deps.promotionRepo.list.mockResolvedValue([]);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.list({ status: "active", type: "coupon_fixed" });

    expect(deps.promotionRepo.list).toHaveBeenCalledWith({ status: "active", type: "coupon_fixed" });
  });
});

// ---------------------------------------------------------------------------
// promotions.get
// ---------------------------------------------------------------------------

describe("promotions.get", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("returns a promotion by ID", async () => {
    const promo = fakePromotion();
    deps.promotionRepo.getById.mockResolvedValue(promo);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.promotions.get({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.promotionRepo.getById).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(result).toEqual(promo);
  });

  it("returns null for non-existent promotion", async () => {
    deps.promotionRepo.getById.mockResolvedValue(null);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.promotions.get({ id: "00000000-0000-0000-0000-000000000000" });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promotions.create
// ---------------------------------------------------------------------------

describe("promotions.create", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("creates a promotion and passes createdBy from ctx.user.id", async () => {
    const created = fakePromotion({ createdBy: "admin-1" });
    deps.promotionRepo.create.mockResolvedValue(created);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.promotions.create({
      name: "Test Promo",
      type: "coupon_fixed",
      valueType: "flat_credits",
      valueAmount: 100,
    });

    expect(deps.promotionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Test Promo",
        type: "coupon_fixed",
        valueType: "flat_credits",
        valueAmount: 100,
        createdBy: "admin-1",
      }),
    );
    expect(result).toEqual(created);
  });

  it("rejects invalid input (empty name)", async () => {
    const caller = appRouter.createCaller(adminCtx());
    await expect(
      caller.promotions.create({
        name: "",
        type: "coupon_fixed",
        valueType: "flat_credits",
        valueAmount: 100,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// promotions.update
// ---------------------------------------------------------------------------

describe("promotions.update", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("updates a draft promotion", async () => {
    deps.promotionRepo.getById.mockResolvedValue(fakePromotion({ status: "draft" }));
    deps.promotionRepo.update.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.update({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", name: "Updated Name" });

    expect(deps.promotionRepo.update).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", {
      name: "Updated Name",
    });
  });

  it("updates a scheduled promotion", async () => {
    deps.promotionRepo.getById.mockResolvedValue(fakePromotion({ status: "scheduled" }));
    deps.promotionRepo.update.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.update({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", name: "Updated" });

    expect(deps.promotionRepo.update).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", { name: "Updated" });
  });

  it("rejects update for active promotion with BAD_REQUEST", async () => {
    deps.promotionRepo.getById.mockResolvedValue(fakePromotion({ status: "active" }));

    const caller = appRouter.createCaller(adminCtx());
    await expect(
      caller.promotions.update({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", name: "Nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects update for non-existent promotion with NOT_FOUND", async () => {
    deps.promotionRepo.getById.mockResolvedValue(null);

    const caller = appRouter.createCaller(adminCtx());
    await expect(
      caller.promotions.update({ id: "00000000-0000-0000-0000-000000000000", name: "Nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// promotions.activate
// ---------------------------------------------------------------------------

describe("promotions.activate", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("activates immediately when startsAt is null", async () => {
    deps.promotionRepo.getById.mockResolvedValue(fakePromotion({ startsAt: null }));
    deps.promotionRepo.updateStatus.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.activate({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.promotionRepo.updateStatus).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "active");
  });

  it("activates immediately when startsAt is in the past", async () => {
    deps.promotionRepo.getById.mockResolvedValue(fakePromotion({ startsAt: new Date("2020-01-01") }));
    deps.promotionRepo.updateStatus.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.activate({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.promotionRepo.updateStatus).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "active");
  });

  it("sets to scheduled when startsAt is in the future", async () => {
    const futureDate = new Date(Date.now() + 86_400_000); // tomorrow
    deps.promotionRepo.getById.mockResolvedValue(fakePromotion({ startsAt: futureDate }));
    deps.promotionRepo.updateStatus.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.activate({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.promotionRepo.updateStatus).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "scheduled");
  });

  it("throws NOT_FOUND for non-existent promotion", async () => {
    deps.promotionRepo.getById.mockResolvedValue(null);

    const caller = appRouter.createCaller(adminCtx());
    await expect(caller.promotions.activate({ id: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
// promotions.pause
// ---------------------------------------------------------------------------

describe("promotions.pause", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("pauses a promotion", async () => {
    deps.promotionRepo.updateStatus.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.pause({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.promotionRepo.updateStatus).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "paused");
  });
});

// ---------------------------------------------------------------------------
// promotions.cancel
// ---------------------------------------------------------------------------

describe("promotions.cancel", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("cancels a promotion", async () => {
    deps.promotionRepo.updateStatus.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.cancel({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.promotionRepo.updateStatus).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "cancelled");
  });
});

// ---------------------------------------------------------------------------
// promotions.generateCouponBatch
// ---------------------------------------------------------------------------

describe("promotions.generateCouponBatch", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("generates the requested number of coupon codes", async () => {
    deps.couponRepo.createBatch.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.promotions.generateCouponBatch({
      promotionId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      count: 5,
    });

    expect(result).toEqual({ generated: 5 });
    expect(deps.couponRepo.createBatch).toHaveBeenCalledTimes(1);
    const [promotionId, codes] = deps.couponRepo.createBatch.mock.calls[0];
    expect(promotionId).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(codes).toHaveLength(5);
    for (const c of codes) {
      expect(c).toHaveProperty("code");
      expect(typeof c.code).toBe("string");
      expect(c.code.length).toBeGreaterThan(0);
    }
  });

  it("rejects count of 0", async () => {
    const caller = appRouter.createCaller(adminCtx());
    await expect(
      caller.promotions.generateCouponBatch({ promotionId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", count: 0 }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// promotions.listRedemptions
// ---------------------------------------------------------------------------

describe("promotions.listRedemptions", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("returns redemptions from the repo", async () => {
    const redemptions = [
      {
        id: "r-1",
        promotionId: "promo-1",
        tenantId: "t-1",
        couponCodeId: null,
        creditsGranted: 100,
        creditTransactionId: "tx-1",
        purchaseAmountCredits: null,
        redeemedAt: new Date(),
      },
    ];
    deps.redemptionRepo.listByPromotion.mockResolvedValue(redemptions);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.promotions.listRedemptions({ promotionId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.redemptionRepo.listByPromotion).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", undefined);
    expect(result).toEqual(redemptions);
  });

  it("passes limit to repo", async () => {
    deps.redemptionRepo.listByPromotion.mockResolvedValue([]);

    const caller = appRouter.createCaller(adminCtx());
    await caller.promotions.listRedemptions({ promotionId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", limit: 10 });

    expect(deps.redemptionRepo.listByPromotion).toHaveBeenCalledWith("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", 10);
  });
});

// ---------------------------------------------------------------------------
// rateOverrides.list
// ---------------------------------------------------------------------------

describe("rateOverrides.list", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("returns rate overrides from repo", async () => {
    const overrides = [fakeRateOverride()];
    deps.rateOverrideRepo.list.mockResolvedValue(overrides);

    const caller = appRouter.createCaller(adminCtx());
    const result = await caller.rateOverrides.list({});

    expect(deps.rateOverrideRepo.list).toHaveBeenCalledWith({
      status: undefined,
      adapterId: undefined,
    });
    expect(result).toEqual(overrides);
  });

  it("passes status and adapterId filters", async () => {
    deps.rateOverrideRepo.list.mockResolvedValue([]);

    const caller = appRouter.createCaller(adminCtx());
    await caller.rateOverrides.list({ status: "active", adapterId: "openai-gpt4" });

    expect(deps.rateOverrideRepo.list).toHaveBeenCalledWith({
      status: "active",
      adapterId: "openai-gpt4",
    });
  });
});

// ---------------------------------------------------------------------------
// rateOverrides.create
// ---------------------------------------------------------------------------

describe("rateOverrides.create", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("creates a rate override with active status when startsAt is in the past", async () => {
    const created = fakeRateOverride();
    deps.rateOverrideRepo.create.mockResolvedValue(created);

    const caller = appRouter.createCaller(adminCtx());
    const pastDate = new Date("2020-01-01");
    const result = await caller.rateOverrides.create({
      adapterId: "openai-gpt4",
      name: "Holiday Sale",
      discountPercent: 20,
      startsAt: pastDate.toISOString(),
    });

    expect(deps.rateOverrideRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "openai-gpt4",
        name: "Holiday Sale",
        discountPercent: 20,
        status: "active",
        createdBy: "admin-1",
        endsAt: null,
        notes: null,
      }),
    );
    expect(result).toEqual(created);
  });

  it("creates a rate override with scheduled status when startsAt is in the future", async () => {
    const created = fakeRateOverride({ status: "scheduled" });
    deps.rateOverrideRepo.create.mockResolvedValue(created);

    const caller = appRouter.createCaller(adminCtx());
    const futureDate = new Date(Date.now() + 86_400_000);
    await caller.rateOverrides.create({
      adapterId: "openai-gpt4",
      name: "Future Sale",
      discountPercent: 15,
      startsAt: futureDate.toISOString(),
    });

    expect(deps.rateOverrideRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "scheduled",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// rateOverrides.cancel
// ---------------------------------------------------------------------------

describe("rateOverrides.cancel", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    setPromotionsRouterDeps(deps);
  });

  it("cancels a rate override and invalidates cache", async () => {
    deps.rateOverrideRepo.getById.mockResolvedValue(fakeRateOverride({ adapterId: "openai-gpt4" }));
    deps.rateOverrideRepo.updateStatus.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    await caller.rateOverrides.cancel({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });

    expect(deps.rateOverrideRepo.updateStatus).toHaveBeenCalledWith(
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "cancelled",
    );
    expect(deps.rateOverrideCacheMock.invalidate).toHaveBeenCalledWith("openai-gpt4");
  });

  it("throws NOT_FOUND for non-existent rate override", async () => {
    deps.rateOverrideRepo.getById.mockResolvedValue(null);

    const caller = appRouter.createCaller(adminCtx());
    await expect(caller.rateOverrides.cancel({ id: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
