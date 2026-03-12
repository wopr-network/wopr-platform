import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterRateOverrideCache,
  IAdapterRateOverrideRepository,
} from "../../monetization/adapters/rate-override-repository.js";
import type { ICouponRepository } from "../../monetization/promotions/coupon-repository.js";
import type { IPromotionRepository, Promotion } from "../../monetization/promotions/promotion-repository.js";
import type { IRedemptionRepository } from "../../monetization/promotions/redemption-repository.js";
import { promotionsRouter, rateOverridesRouter, setPromotionsRouterDeps } from "./promotions.js";

const PROMO_ID = "a0000000-0000-4000-8000-000000000001";

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: PROMO_ID,
    name: "Test Promo",
    type: "bonus_on_purchase",
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
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    notes: null,
    ...overrides,
  };
}

type PromotionCallerCtx = Parameters<typeof promotionsRouter.createCaller>[0];
type RateOverrideCallerCtx = Parameters<typeof rateOverridesRouter.createCaller>[0];

function adminCtx(): PromotionCallerCtx {
  return {
    user: { id: "admin-1", roles: ["platform_admin"] },
    tenantId: undefined,
  };
}

describe("promotionsRouter", () => {
  let mockPromotionRepo: Record<keyof IPromotionRepository, ReturnType<typeof vi.fn>>;
  let mockCouponRepo: Record<keyof ICouponRepository, ReturnType<typeof vi.fn>>;
  let mockRedemptionRepo: Record<keyof IRedemptionRepository, ReturnType<typeof vi.fn>>;
  let mockRateOverrideRepo: Record<keyof IAdapterRateOverrideRepository, ReturnType<typeof vi.fn>>;
  let mockRateOverrideCache: {
    invalidate: ReturnType<typeof vi.fn>;
    invalidateAll: ReturnType<typeof vi.fn>;
    getDiscountPercent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockPromotionRepo = {
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
    mockCouponRepo = {
      createBatch: vi.fn(),
      findByCode: vi.fn(),
      redeem: vi.fn(),
      listByPromotion: vi.fn(),
      countRedeemed: vi.fn(),
      getUserRedemptionCount: vi.fn(),
    };
    mockRedemptionRepo = {
      create: vi.fn(),
      listByPromotion: vi.fn(),
      countByTenant: vi.fn(),
      hasPriorPurchase: vi.fn(),
    };
    mockRateOverrideRepo = {
      create: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      findActiveForAdapter: vi.fn(),
      updateStatus: vi.fn(),
    };
    mockRateOverrideCache = {
      invalidate: vi.fn(),
      invalidateAll: vi.fn(),
      getDiscountPercent: vi.fn(),
    };
    setPromotionsRouterDeps({
      promotionRepo: mockPromotionRepo as unknown as IPromotionRepository,
      couponRepo: mockCouponRepo as unknown as ICouponRepository,
      redemptionRepo: mockRedemptionRepo as unknown as IRedemptionRepository,
      rateOverrideRepo: mockRateOverrideRepo as unknown as IAdapterRateOverrideRepository,
      rateOverrideCache: mockRateOverrideCache as unknown as AdapterRateOverrideCache,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it("should list promotions with optional filters", async () => {
      const promos = [makePromotion()];
      mockPromotionRepo.list.mockResolvedValue(promos);

      const caller = promotionsRouter.createCaller(adminCtx());
      const result = await caller.list({ status: "draft" });
      expect(mockPromotionRepo.list).toHaveBeenCalledWith({ status: "draft", type: undefined });
      expect(result).toEqual(promos);
    });
  });

  describe("get", () => {
    it("should get a promotion by ID", async () => {
      const promo = makePromotion();
      mockPromotionRepo.getById.mockResolvedValue(promo);

      const caller = promotionsRouter.createCaller(adminCtx());
      const result = await caller.get({ id: PROMO_ID });
      expect(result).toEqual(promo);
    });
  });

  describe("create", () => {
    it("should create a promotion with createdBy from ctx", async () => {
      const promo = makePromotion();
      mockPromotionRepo.create.mockResolvedValue(promo);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.create({
        name: "Test Promo",
        type: "bonus_on_purchase",
        valueType: "flat_credits",
        valueAmount: 100,
      });
      expect(mockPromotionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Test Promo", createdBy: "admin-1" }),
      );
    });
  });

  describe("update", () => {
    it("should update a draft promotion", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ status: "draft" }));
      mockPromotionRepo.update.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.update({ id: PROMO_ID, name: "Updated" });
      expect(mockPromotionRepo.update).toHaveBeenCalledWith(PROMO_ID, { name: "Updated" });
    });

    it("should reject update for active promotion", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ status: "active" }));

      const caller = promotionsRouter.createCaller(adminCtx());
      await expect(caller.update({ id: PROMO_ID, name: "Updated" })).rejects.toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
    });

    it("should throw NOT_FOUND when promotion does not exist", async () => {
      mockPromotionRepo.getById.mockResolvedValue(null);

      const caller = promotionsRouter.createCaller(adminCtx());
      await expect(caller.update({ id: PROMO_ID, name: "x" })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });
  });

  describe("activate", () => {
    it("should set status to active when startsAt is in the past", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ startsAt: new Date("2020-01-01") }));
      mockPromotionRepo.updateStatus.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.activate({ id: PROMO_ID });
      expect(mockPromotionRepo.updateStatus).toHaveBeenCalledWith(PROMO_ID, "active");
    });

    it("should set status to scheduled when startsAt is in the future", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ startsAt: new Date("2099-01-01") }));
      mockPromotionRepo.updateStatus.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.activate({ id: PROMO_ID });
      expect(mockPromotionRepo.updateStatus).toHaveBeenCalledWith(PROMO_ID, "scheduled");
    });

    it("should set status to active when startsAt is null", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ startsAt: null }));
      mockPromotionRepo.updateStatus.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.activate({ id: PROMO_ID });
      expect(mockPromotionRepo.updateStatus).toHaveBeenCalledWith(PROMO_ID, "active");
    });
  });

  describe("pause", () => {
    it("should pause a promotion", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ status: "active" }));
      mockPromotionRepo.updateStatus.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.pause({ id: PROMO_ID });
      expect(mockPromotionRepo.updateStatus).toHaveBeenCalledWith(PROMO_ID, "paused");
    });
  });

  describe("cancel", () => {
    it("should cancel a promotion", async () => {
      mockPromotionRepo.getById.mockResolvedValue(makePromotion({ status: "active" }));
      mockPromotionRepo.updateStatus.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      await caller.cancel({ id: PROMO_ID });
      expect(mockPromotionRepo.updateStatus).toHaveBeenCalledWith(PROMO_ID, "cancelled");
    });
  });

  describe("generateCouponBatch", () => {
    it("should generate coupon codes and call createBatch", async () => {
      vi.spyOn(crypto, "randomBytes").mockReturnValue(Buffer.from("abcdef") as never);
      mockCouponRepo.createBatch.mockResolvedValue(undefined);

      const caller = promotionsRouter.createCaller(adminCtx());
      const result = await caller.generateCouponBatch({
        promotionId: PROMO_ID,
        count: 3,
      });
      expect(result).toEqual({ generated: 3 });
      expect(mockCouponRepo.createBatch).toHaveBeenCalledWith(
        PROMO_ID,
        expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
      );
    });
  });

  describe("listRedemptions", () => {
    it("should list redemptions for a promotion", async () => {
      mockRedemptionRepo.listByPromotion.mockResolvedValue([]);

      const caller = promotionsRouter.createCaller(adminCtx());
      const result = await caller.listRedemptions({
        promotionId: PROMO_ID,
      });
      expect(result).toEqual([]);
    });
  });
});

describe("rateOverridesRouter", () => {
  let mockRateOverrideRepo: Record<keyof IAdapterRateOverrideRepository, ReturnType<typeof vi.fn>>;
  let mockRateOverrideCache: {
    invalidate: ReturnType<typeof vi.fn>;
    invalidateAll: ReturnType<typeof vi.fn>;
    getDiscountPercent: ReturnType<typeof vi.fn>;
  };

  function adminCtxRO(): RateOverrideCallerCtx {
    return {
      user: { id: "admin-1", roles: ["platform_admin"] },
      tenantId: undefined,
    };
  }

  beforeEach(() => {
    mockRateOverrideRepo = {
      create: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      findActiveForAdapter: vi.fn(),
      updateStatus: vi.fn(),
    };
    mockRateOverrideCache = {
      invalidate: vi.fn(),
      invalidateAll: vi.fn(),
      getDiscountPercent: vi.fn(),
    };
    setPromotionsRouterDeps({
      promotionRepo: {} as unknown as IPromotionRepository,
      couponRepo: {} as unknown as ICouponRepository,
      redemptionRepo: {} as unknown as IRedemptionRepository,
      rateOverrideRepo: mockRateOverrideRepo as unknown as IAdapterRateOverrideRepository,
      rateOverrideCache: mockRateOverrideCache as unknown as AdapterRateOverrideCache,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it("should list rate overrides", async () => {
      mockRateOverrideRepo.list.mockResolvedValue([
        {
          id: "override-1",
          adapterId: "adapter-a",
          name: "Test",
          discountPercent: 10,
          startsAt: new Date("2025-01-01"),
          endsAt: null,
          status: "active",
          createdBy: "admin-1",
          createdAt: new Date("2025-01-01"),
          notes: null,
        },
      ]);

      const caller = rateOverridesRouter.createCaller(adminCtxRO());
      const result = await caller.list({});
      expect(result).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("should create with active status when startsAt is in the past", async () => {
      mockRateOverrideRepo.create.mockResolvedValue({
        id: "override-1",
        adapterId: "adapter-a",
        name: "Test Override",
        discountPercent: 10,
        startsAt: new Date("2020-01-01"),
        endsAt: null,
        status: "active",
        createdBy: "admin-1",
        createdAt: new Date("2020-01-01"),
        notes: null,
      });

      const caller = rateOverridesRouter.createCaller(adminCtxRO());
      await caller.create({
        adapterId: "adapter-a",
        name: "Test Override",
        discountPercent: 10,
        startsAt: new Date("2020-01-01"),
      });
      expect(mockRateOverrideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active", createdBy: "admin-1" }),
      );
    });

    it("should create with scheduled status when startsAt is in the future", async () => {
      mockRateOverrideRepo.create.mockResolvedValue({
        id: "override-2",
        adapterId: "adapter-a",
        name: "Future Override",
        discountPercent: 20,
        startsAt: new Date("2099-01-01"),
        endsAt: null,
        status: "scheduled",
        createdBy: "admin-1",
        createdAt: new Date("2026-01-01"),
        notes: null,
      });

      const caller = rateOverridesRouter.createCaller(adminCtxRO());
      await caller.create({
        adapterId: "adapter-a",
        name: "Future Override",
        discountPercent: 20,
        startsAt: new Date("2099-01-01"),
      });
      expect(mockRateOverrideRepo.create).toHaveBeenCalledWith(expect.objectContaining({ status: "scheduled" }));
    });
  });

  describe("cancel", () => {
    it("should cancel a rate override and invalidate cache", async () => {
      mockRateOverrideRepo.getById.mockResolvedValue({
        id: "override-1",
        adapterId: "adapter-a",
        name: "Test",
        discountPercent: 10,
        startsAt: new Date("2025-01-01"),
        endsAt: null,
        status: "active",
        createdBy: "admin-1",
        createdAt: new Date("2025-01-01"),
        notes: null,
      });
      mockRateOverrideRepo.updateStatus.mockResolvedValue(undefined);

      const caller = rateOverridesRouter.createCaller(adminCtxRO());
      await caller.cancel({ id: PROMO_ID });
      expect(mockRateOverrideRepo.updateStatus).toHaveBeenCalledWith(PROMO_ID, "cancelled");
      expect(mockRateOverrideCache.invalidate).toHaveBeenCalledWith("adapter-a");
    });

    it("should throw NOT_FOUND when override does not exist", async () => {
      mockRateOverrideRepo.getById.mockResolvedValue(null);

      const caller = rateOverridesRouter.createCaller(adminCtxRO());
      await expect(caller.cancel({ id: PROMO_ID })).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });
  });
});
