import { config } from "../../config/index.js";
import { Credit } from "../credit.js";
import type { ICreditLedger } from "../credits/credit-ledger.js";
import type { IAffiliateRepository } from "./drizzle-affiliate-repository.js";

/** Default bonus rate: 20% of purchase amount. Override with AFFILIATE_NEW_USER_BONUS_RATE env var. */
export const DEFAULT_BONUS_RATE = config.billing.affiliateNewUserBonusRate;

export interface NewUserBonusParams {
  ledger: ICreditLedger;
  affiliateRepo: IAffiliateRepository;
  referredTenantId: string;
  purchaseAmount: Credit;
  bonusRate?: number;
}

export interface NewUserBonusResult {
  granted: boolean;
  bonus: Credit;
}

/**
 * Grant a first-purchase bonus to a referred user.
 *
 * Idempotent: uses `affiliate-bonus:<tenantId>` as referenceId.
 * No-op if tenant is not referred, already received bonus, or bonus rounds to 0.
 */
export async function grantNewUserBonus(params: NewUserBonusParams): Promise<NewUserBonusResult> {
  const { ledger, affiliateRepo, referredTenantId, purchaseAmount } = params;
  const rate = params.bonusRate ?? DEFAULT_BONUS_RATE;
  const SKIP: NewUserBonusResult = { granted: false, bonus: Credit.ZERO };

  // 1. Look up referral — skip if not referred
  const referral = await affiliateRepo.getReferral(referredTenantId);
  if (!referral) {
    return SKIP;
  }

  // 2. Skip if first purchase already recorded (WOP-949 or prior run set it)
  if (referral.firstPurchaseAt != null) {
    return SKIP;
  }

  // 3. Idempotency: skip if bonus already credited
  const refId = `affiliate-bonus:${referredTenantId}`;
  if (await ledger.hasReferenceId(refId)) {
    return SKIP;
  }

  // 4. Compute bonus
  const bonus = purchaseAmount.multiply(rate);
  if (bonus.isZero() || bonus.isNegative()) {
    return SKIP;
  }

  // 5. Mark first purchase on the referral row (no-op if already set)
  await affiliateRepo.markFirstPurchase(referredTenantId);

  // 6. Credit the bonus
  await ledger.credit(
    referredTenantId,
    bonus,
    "affiliate_bonus",
    `New user first-purchase bonus (${Math.round(rate * 100)}%)`,
    refId,
  );

  return { granted: true, bonus };
}
