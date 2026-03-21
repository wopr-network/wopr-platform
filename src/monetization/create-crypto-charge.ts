/**
 * Shared crypto charge creation logic.
 * Used by both REST (/billing/crypto/checkout) and tRPC (cryptoCheckout).
 */
import type { CryptoServiceClient, ICryptoChargeRepository } from "@wopr-network/platform-core/billing";
import { logger } from "@wopr-network/platform-core/config/logger";
import { Credit } from "@wopr-network/platform-core/credits";

export interface CreateCryptoChargeResult {
  chargeId: string;
  address: string;
  referenceId: string;
  chain: string;
}

/**
 * Create a crypto charge via the key server and record it locally.
 * Calls the key server, stores the charge in the local DB, and returns the
 * charge details for display to the user.
 */
export async function createCryptoCharge(
  cryptoClient: CryptoServiceClient,
  chargeStore: ICryptoChargeRepository,
  tenant: string,
  amountUsd: number,
  callbackUrl?: string,
): Promise<CreateCryptoChargeResult> {
  const charge = await cryptoClient.createCharge({
    chain: "btc",
    amountUsd,
    callbackUrl,
    metadata: { tenant },
  });
  // stored in cents for webhook-driven credit grant (not a Stripe/Payram API boundary)
  const amountStoredCents = Credit.fromDollars(amountUsd).toCentsRounded();
  try {
    await chargeStore.create(charge.chargeId, tenant, amountStoredCents);
  } catch (err) {
    // Log chargeId so ops can manually reconcile the orphan charge if persistence fails
    try {
      logger.error(
        `Failed to persist crypto charge ${charge.chargeId} for ${tenant} — manual reconciliation required`,
        err,
      );
    } catch {
      // logging failure must not mask primary persistence error
    }
    throw err;
  }
  return { chargeId: charge.chargeId, address: charge.address, referenceId: charge.chargeId, chain: charge.chain };
}
