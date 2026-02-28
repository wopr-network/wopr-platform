import { beforeEach, describe, expect, it, vi } from "vitest";
import { Credit } from "../credit.js";
import type { ICreditLedger } from "../credits/credit-ledger.js";
import type { ICouponRepository } from "./coupon-repository.js";
import { PromotionEngine } from "./engine.js";
import type { IPromotionRepository, Promotion } from "./promotion-repository.js";
import type { IRedemptionRepository } from "./redemption-repository.js";

function makePromo(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: "promo-1",
    name: "Test",
    type: "bonus_on_purchase",
    status: "active",
    startsAt: null,
    endsAt: null,
    valueType: "flat_credits",
    valueAmount: 1000, // $10 in cents
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
    createdBy: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    notes: null,
    ...overrides,
  };
}

describe("PromotionEngine", () => {
  let promotionRepo: IPromotionRepository;
  let couponRepo: ICouponRepository;
  let redemptionRepo: IRedemptionRepository;
  let ledger: ICreditLedger;
  let engine: PromotionEngine;

  beforeEach(() => {
    promotionRepo = {
      listActive: vi.fn().mockResolvedValue([makePromo()]),
      findByCouponCode: vi.fn().mockResolvedValue(null),
      incrementUsage: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      updateStatus: vi.fn(),
      update: vi.fn(),
    } as unknown as IPromotionRepository;

    couponRepo = {
      getUserRedemptionCount: vi.fn().mockResolvedValue(0),
      findByCode: vi.fn().mockResolvedValue(null),
      redeem: vi.fn().mockResolvedValue(undefined),
      createBatch: vi.fn(),
      listByPromotion: vi.fn(),
      countRedeemed: vi.fn(),
    } as unknown as ICouponRepository;

    redemptionRepo = {
      create: vi.fn().mockResolvedValue({
        id: "r1",
        promotionId: "promo-1",
        tenantId: "tenant-1",
        couponCodeId: null,
        creditsGranted: 1000,
        creditTransactionId: "tx-1",
        purchaseAmountCredits: null,
        redeemedAt: new Date(),
      }),
      countByTenant: vi.fn().mockResolvedValue(0),
      listByPromotion: vi.fn(),
    } as unknown as IRedemptionRepository;

    ledger = {
      credit: vi.fn().mockResolvedValue({
        id: "tx-1",
        tenantId: "tenant-1",
        amount: Credit.fromCents(1000),
        balanceAfter: Credit.fromCents(1000),
        type: "promo",
        description: null,
        referenceId: "promo:promo-1:tenant-1",
        fundingSource: null,
        attributedUserId: null,
        createdAt: new Date().toISOString(),
      }),
      hasReferenceId: vi.fn().mockResolvedValue(false),
    } as unknown as ICreditLedger;

    engine = new PromotionEngine({ promotionRepo, couponRepo, redemptionRepo, ledger });
  });

  it("grants flat credits on purchase trigger", async () => {
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(2500),
    });
    expect(results).toHaveLength(1);
    expect(ledger.credit).toHaveBeenCalledWith(
      "tenant-1",
      expect.any(Object), // Credit instance
      "promo",
      expect.any(String),
      "promo:promo-1:tenant-1",
    );
  });

  it("skips if already redeemed (idempotency)", async () => {
    vi.mocked(ledger.hasReferenceId).mockResolvedValue(true);
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(2500),
    });
    expect(results).toHaveLength(0);
    expect(ledger.credit).not.toHaveBeenCalled();
  });

  it("respects per_user_limit", async () => {
    vi.mocked(redemptionRepo.countByTenant).mockResolvedValue(1);
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(2500),
    });
    expect(results).toHaveLength(0);
  });

  it("respects minimum purchase amount", async () => {
    vi.mocked(promotionRepo.listActive).mockResolvedValue([makePromo({ minPurchaseCredits: 5000 })]);
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(2500),
    });
    expect(results).toHaveLength(0);
  });

  it("computes percent-of-purchase correctly", async () => {
    vi.mocked(promotionRepo.listActive).mockResolvedValue([
      makePromo({ valueType: "percent_of_purchase", valueAmount: 2000 }), // 2000 basis points = 20%
    ]);
    await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(10000), // $100
    });
    // 20% of $100 = $20
    const [, grantedAmount] = vi.mocked(ledger.credit).mock.calls[0];
    expect((grantedAmount as Credit).toCents()).toBe(2000);
  });

  it("respects max_value_credits cap on percent promos", async () => {
    vi.mocked(promotionRepo.listActive).mockResolvedValue([
      makePromo({ valueType: "percent_of_purchase", valueAmount: 5000, maxValueCredits: 1000 }), // 50% capped at $10
    ]);
    await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(10000), // $100 → 50% = $50, capped at $10
    });
    const [, grantedAmount] = vi.mocked(ledger.credit).mock.calls[0];
    expect((grantedAmount as Credit).toCents()).toBe(1000);
  });

  it("respects budget cap", async () => {
    vi.mocked(promotionRepo.listActive).mockResolvedValue([
      makePromo({ budgetCredits: 500, totalCreditsGranted: 400, valueAmount: 200 }),
    ]);
    // 400 already granted + 200 would = 600 > 500 budget
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(2500),
    });
    expect(results).toHaveLength(0);
  });

  it("respects total use limit", async () => {
    vi.mocked(promotionRepo.listActive).mockResolvedValue([makePromo({ totalUseLimit: 10, totalUses: 10 })]);
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "purchase",
    });
    expect(results).toHaveLength(0);
  });

  it("processes coupon_redeem trigger by looking up coupon code", async () => {
    vi.mocked(promotionRepo.findByCouponCode).mockResolvedValue(
      makePromo({ type: "coupon_fixed", couponCode: "LAUNCH50", valueAmount: 500 }),
    );
    const results = await engine.evaluateAndGrant({
      tenantId: "tenant-1",
      trigger: "coupon_redeem",
      couponCode: "LAUNCH50",
    });
    expect(results).toHaveLength(1);
    expect(promotionRepo.findByCouponCode).toHaveBeenCalledWith("LAUNCH50");
  });
});
