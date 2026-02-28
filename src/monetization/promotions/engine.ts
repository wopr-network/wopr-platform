import { Credit } from "../credit.js";
import type { ICreditLedger } from "../credits/credit-ledger.js";
import type { ICouponRepository } from "./coupon-repository.js";
import type { IPromotionRepository, Promotion } from "./promotion-repository.js";
import type { IRedemptionRepository } from "./redemption-repository.js";

export interface PromotionContext {
  tenantId: string;
  trigger: "purchase" | "coupon_redeem" | "batch";
  couponCode?: string;
  purchaseAmountCredits?: Credit;
}

export interface GrantResult {
  promotionId: string;
  promotionName: string;
  creditsGranted: Credit;
  transactionId: string;
}

interface PromotionEngineDeps {
  promotionRepo: IPromotionRepository;
  couponRepo: ICouponRepository;
  redemptionRepo: IRedemptionRepository;
  ledger: ICreditLedger;
}

export class PromotionEngine {
  constructor(private readonly deps: PromotionEngineDeps) {}

  async evaluateAndGrant(ctx: PromotionContext): Promise<GrantResult[]> {
    const { promotionRepo } = this.deps;
    const results: GrantResult[] = [];

    let candidates: Promotion[];

    if (ctx.trigger === "coupon_redeem" && ctx.couponCode) {
      const promo = await promotionRepo.findByCouponCode(ctx.couponCode);
      candidates = promo ? [promo] : [];
    } else if (ctx.trigger === "purchase") {
      candidates = await promotionRepo.listActive({ type: "bonus_on_purchase" });
    } else {
      candidates = await promotionRepo.listActive();
    }

    for (const promo of candidates) {
      const result = await this.#tryGrant(promo, ctx);
      if (result) results.push(result);
    }

    return results;
  }

  async #tryGrant(promo: Promotion, ctx: PromotionContext): Promise<GrantResult | null> {
    const { redemptionRepo, ledger, promotionRepo } = this.deps;

    // Idempotency
    const refId = `promo:${promo.id}:${ctx.tenantId}`;
    if (await ledger.hasReferenceId(refId)) return null;

    // Per-user limit
    const userCount = await redemptionRepo.countByTenant(promo.id, ctx.tenantId);
    if (userCount >= promo.perUserLimit) return null;

    // Total use limit
    if (promo.totalUseLimit !== null && promo.totalUses >= promo.totalUseLimit) return null;

    // Minimum purchase check
    if (promo.minPurchaseCredits !== null && ctx.purchaseAmountCredits !== undefined) {
      if (ctx.purchaseAmountCredits.toCents() < promo.minPurchaseCredits) return null;
    }

    // Compute grant amount
    let grantAmount: Credit;
    if (promo.valueType === "flat_credits") {
      grantAmount = Credit.fromCents(promo.valueAmount);
    } else {
      // percent_of_purchase — valueAmount is basis points (10000 = 100%)
      const purchase = ctx.purchaseAmountCredits ?? Credit.ZERO;
      const raw = Math.floor((purchase.toCents() * promo.valueAmount) / 10000);
      grantAmount = Credit.fromCents(raw);
      if (promo.maxValueCredits !== null) {
        grantAmount = Credit.fromCents(Math.min(grantAmount.toCents(), promo.maxValueCredits));
      }
    }

    if (grantAmount.isZero() || grantAmount.isNegative()) return null;

    // Budget check
    if (promo.budgetCredits !== null) {
      if (promo.totalCreditsGranted + grantAmount.toCents() > promo.budgetCredits) return null;
    }

    // Grant credits
    const tx = await ledger.credit(ctx.tenantId, grantAmount, "promo", `Promotion: ${promo.name}`, refId);

    // Record redemption
    await redemptionRepo.create({
      promotionId: promo.id,
      tenantId: ctx.tenantId,
      creditsGranted: grantAmount.toCents(),
      creditTransactionId: tx.id,
      purchaseAmountCredits: ctx.purchaseAmountCredits?.toCents(),
    });

    await promotionRepo.incrementUsage(promo.id, grantAmount.toCents());

    return {
      promotionId: promo.id,
      promotionName: promo.name,
      creditsGranted: grantAmount,
      transactionId: tx.id,
    };
  }
}
