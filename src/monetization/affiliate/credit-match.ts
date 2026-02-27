import type { Credit } from "../credit.js";
import type { ICreditLedger } from "../credits/credit-ledger.js";
import type { IAffiliateRepository } from "./drizzle-affiliate-repository.js";

const DEFAULT_MATCH_RATE = Number.parseFloat(process.env.AFFILIATE_MATCH_RATE ?? "1.0");

export interface AffiliateCreditMatchDeps {
  tenantId: string;
  purchaseAmount: Credit;
  ledger: ICreditLedger;
  affiliateRepo: IAffiliateRepository;
  matchRate?: number;
}

export interface AffiliateCreditMatchResult {
  referrerTenantId: string;
  matchAmount: Credit;
}

/**
 * Process affiliate credit match for a tenant's purchase.
 *
 * Returns match result if credits were granted, null otherwise.
 * Idempotent — uses referenceId `affiliate_match:<referredTenantId>`.
 */
export async function processAffiliateCreditMatch(
  deps: AffiliateCreditMatchDeps,
): Promise<AffiliateCreditMatchResult | null> {
  const { tenantId, purchaseAmount, ledger, affiliateRepo } = deps;
  const matchRate = deps.matchRate ?? DEFAULT_MATCH_RATE;

  // 1. Check if tenant has a referral record
  const referral = await affiliateRepo.getReferralByReferred(tenantId);
  if (!referral) return null;

  // 2. Already matched? (idempotency via matchedAt)
  if (referral.matchedAt) return null;

  // 3. Check if this is the first purchase — only 1 purchase type transaction should exist
  const purchaseHistory = await ledger.history(tenantId, { type: "purchase", limit: 2 });
  if (purchaseHistory.length !== 1) return null;

  // 4. Idempotency via referenceId on the credit transaction
  const refId = `affiliate_match:${tenantId}`;
  if (await ledger.hasReferenceId(refId)) return null;

  // 5. Compute match
  const matchAmount = purchaseAmount.multiply(matchRate);
  if (matchAmount.isZero() || matchAmount.isNegative()) return null;

  // 6. Credit the referrer
  await ledger.credit(
    referral.referrerTenantId,
    matchAmount,
    "affiliate_match",
    `Affiliate match for referred tenant ${tenantId}`,
    refId,
  );

  // 7. Update referral record
  await affiliateRepo.markFirstPurchase(tenantId);
  await affiliateRepo.recordMatch(tenantId, matchAmount);

  return {
    referrerTenantId: referral.referrerTenantId,
    matchAmount,
  };
}
