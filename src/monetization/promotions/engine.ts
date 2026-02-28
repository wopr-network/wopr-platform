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
    const { redemptionRepo, ledger, promotionRepo, couponRepo } = this.deps;

    // Per-user limit
    const userCount = await redemptionRepo.countByTenant(promo.id, ctx.tenantId);
    if (userCount >= promo.perUserLimit) return null;

    // Idempotency — include redemption sequence so users allowed multiple uses can redeem each once
    const refId = `promo:${promo.id}:${ctx.tenantId}:${userCount + 1}`;
    if (await ledger.hasReferenceId(refId)) return null;

    // firstPurchaseOnly: skip if the tenant has made any prior purchase
    if (promo.firstPurchaseOnly && ctx.trigger === "purchase") {
      if (await redemptionRepo.hasPriorPurchase(ctx.tenantId)) return null;
    }

    // userSegment enforcement
    if (promo.userSegment === "tenant_list") {
      if (!promo.eligibleTenantIds || !promo.eligibleTenantIds.includes(ctx.tenantId)) return null;
    }

    // Minimum purchase check — treat missing purchaseAmountCredits as zero
    if (promo.minPurchaseCredits !== null) {
      const purchaseCents = ctx.purchaseAmountCredits?.toCents() ?? 0;
      if (purchaseCents < promo.minPurchaseCredits) return null;
    }

    // For unique batch codes, validate and mark the specific code
    let couponCodeId: string | undefined;
    if (promo.type === "coupon_unique" && ctx.couponCode) {
      const couponCode = await couponRepo.findByCode(ctx.couponCode);
      if (!couponCode || couponCode.redeemedAt !== null) return null;
      if (couponCode.promotionId !== promo.id) return null;
      couponCodeId = couponCode.id;
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

    // Atomic budget + total-use-limit check + usage increment (must run BEFORE crediting)
    const granted = await promotionRepo.incrementUsageIfAllowed(
      promo.id,
      grantAmount.toCents(),
      promo.budgetCredits,
      promo.totalUseLimit,
    );
    if (!granted) return null;

    // Grant credits
    const tx = await ledger.credit(ctx.tenantId, grantAmount, "promo", `Promotion: ${promo.name}`, refId);

    // Record redemption
    await redemptionRepo.create({
      promotionId: promo.id,
      tenantId: ctx.tenantId,
      couponCodeId,
      creditsGranted: grantAmount.toCents(),
      creditTransactionId: tx.id,
      purchaseAmountCredits: ctx.purchaseAmountCredits?.toCents(),
    });

    // Mark unique coupon code as redeemed
    if (couponCodeId) {
      await couponRepo.redeem(couponCodeId, ctx.tenantId);
    }

    return {
      promotionId: promo.id,
      promotionName: promo.name,
      creditsGranted: grantAmount,
      transactionId: tx.id,
    };
  }
}
