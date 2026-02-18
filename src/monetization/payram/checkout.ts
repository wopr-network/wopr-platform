import type { Payram } from "payram";
import type { PayRamChargeStore } from "./charge-store.js";
import type { PayRamCheckoutOpts } from "./types.js";

/** Minimum payment amount in USD. */
export const MIN_PAYMENT_USD = 10;

/**
 * Create a PayRam payment session and store the charge record.
 *
 * Returns the PayRam-hosted payment page URL and reference ID.
 * The user is redirected to this URL to complete the crypto payment.
 */
export async function createPayRamCheckout(
  payram: Payram,
  chargeStore: PayRamChargeStore,
  opts: PayRamCheckoutOpts,
): Promise<{ referenceId: string; url: string }> {
  if (opts.amountUsd < MIN_PAYMENT_USD) {
    throw new Error(`Minimum payment amount is $${MIN_PAYMENT_USD}`);
  }

  const result = await payram.payments.initiatePayment({
    customerEmail: `${opts.tenant}@wopr.bot`,
    customerId: opts.tenant,
    amountInUSD: opts.amountUsd,
  });

  // Store the charge record for webhook correlation.
  chargeStore.create(
    result.reference_id,
    opts.tenant,
    Math.round(opts.amountUsd * 100), // Convert to cents
  );

  return {
    referenceId: result.reference_id,
    url: result.url,
  };
}
