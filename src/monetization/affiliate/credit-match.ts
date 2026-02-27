import { Credit } from "../credit.js";
import type { ICreditLedger } from "../credits/credit-ledger.js";
import type { IAffiliateFraudRepository } from "./affiliate-fraud-repository.js";
import type { IAffiliateRepository } from "./drizzle-affiliate-repository.js";
import { checkSelfReferral } from "./self-referral-detector.js";

const DEFAULT_MATCH_RATE = Number.parseFloat(process.env.AFFILIATE_MATCH_RATE ?? "1.0");

export interface AffiliateCreditMatchDeps {
  tenantId: string;
  purchaseAmountCents: number;
  ledger: ICreditLedger;
  affiliateRepo: IAffiliateRepository;
  matchRate?: number;
  fraudRepo?: IAffiliateFraudRepository;
  referrerIp?: string | null;
  referrerEmail?: string | null;
  referrerStripeCustomerId?: string | null;
  referredStripeCustomerId?: string | null;
}

export interface AffiliateCreditMatchResult {
  referrerTenantId: string;
  matchAmountCents: number;
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
  const { tenantId, purchaseAmountCents, ledger, affiliateRepo } = deps;
  const matchRate = deps.matchRate ?? DEFAULT_MATCH_RATE;

  // 1. Check if tenant has a referral record
  const referral = await affiliateRepo.getReferralByReferred(tenantId);
  if (!referral) return null;

  // 2. Already matched? (idempotency via matchedAt)
  if (referral.matchedAt) return null;

  // 3. Check if this is the first purchase — only 1 purchase type transaction should exist
  const purchaseHistory = await ledger.history(tenantId, { type: "purchase", limit: 2 });
  if (purchaseHistory.length !== 1) return null;

  // 4b. Self-referral fraud detection (WOP-1061)
  if (deps.fraudRepo) {
    const existingReferrals = await affiliateRepo.listByReferrer(referral.referrerTenantId);
    const fraudResult = checkSelfReferral({
      referrerTenantId: referral.referrerTenantId,
      referredTenantId: tenantId,
      referralId: referral.id,
      referredIp: referral.signupIp ?? null,
      referredEmail: referral.signupEmail ?? null,
      existingReferrals: existingReferrals
        .filter((r) => r.referredTenantId !== tenantId)
        .map((r) => ({
          referredTenantId: r.referredTenantId,
          signupIp: r.signupIp ?? null,
          signupEmail: r.signupEmail ?? null,
        })),
      referrerIp: deps.referrerIp ?? null,
      referrerEmail: deps.referrerEmail ?? null,
      referrerStripeCustomerId: deps.referrerStripeCustomerId ?? null,
      referredStripeCustomerId: deps.referredStripeCustomerId ?? null,
    });

    if (fraudResult.verdict !== "clean") {
      await deps.fraudRepo.record({
        referralId: referral.id,
        referrerTenantId: referral.referrerTenantId,
        referredTenantId: tenantId,
        verdict: fraudResult.verdict,
        signals: fraudResult.signals,
        signalDetails: fraudResult.signalDetails,
        phase: "payout",
      });
    }

    if (fraudResult.verdict === "blocked") {
      return null;
    }
  }

  // 4. Idempotency via referenceId on the credit transaction
  const refId = `affiliate_match:${tenantId}`;
  if (await ledger.hasReferenceId(refId)) return null;

  // 5. Compute match
  const matchAmountCents = Math.floor(purchaseAmountCents * matchRate);
  if (matchAmountCents <= 0) return null;

  // 6. Credit the referrer
  await ledger.credit(
    referral.referrerTenantId,
    Credit.fromCents(matchAmountCents),
    "affiliate_match",
    `Affiliate match for referred tenant ${tenantId}`,
    refId,
  );

  // 7. Update referral record
  await affiliateRepo.markFirstPurchase(tenantId);
  await affiliateRepo.recordMatch(tenantId, matchAmountCents);

  return {
    referrerTenantId: referral.referrerTenantId,
    matchAmountCents,
  };
}
