import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
import type { Credit } from "../credit.js";
import type { ITenantCustomerStore } from "../stripe/tenant-store.js";
import type { IAutoTopupEventLogRepository } from "./auto-topup-event-log-repository.js";
import type { ICreditLedger } from "./credit-ledger.js";

/** After this many consecutive Stripe failures, the auto-topup mode is disabled. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface AutoTopupChargeDeps {
  stripe: Stripe;
  tenantStore: ITenantCustomerStore;
  creditLedger: ICreditLedger;
  eventLogRepo: IAutoTopupEventLogRepository;
}

export interface AutoTopupChargeResult {
  success: boolean;
  paymentReference?: string;
  error?: string;
}

/**
 * Charge a tenant's default Stripe payment method off-session and credit their ledger.
 *
 * Writes to both `credit_transactions` (type=purchase) and `credit_auto_topup` event log.
 *
 * @param source - Descriptive source tag for the credit_transactions description
 *                 (e.g., "auto_topup_usage" or "auto_topup_schedule")
 */
export async function chargeAutoTopup(
  deps: AutoTopupChargeDeps,
  tenantId: string,
  amount: Credit,
  source: string,
): Promise<AutoTopupChargeResult> {
  const amountCents = amount.toCentsRounded();

  // 1. Look up Stripe customer
  const mapping = await deps.tenantStore.getByTenant(tenantId);
  if (!mapping) {
    const error = `No Stripe customer for tenant ${tenantId}`;
    await deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
    return { success: false, error };
  }

  const customerId = mapping.processor_customer_id;

  // 2. Get default payment method
  let paymentMethodId: string;
  try {
    const methods = await deps.stripe.customers.listPaymentMethods(customerId, { limit: 1 });
    if (!methods.data.length) {
      const error = `No payment method on file for tenant ${tenantId}`;
      await deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
      return { success: false, error };
    }
    paymentMethodId = methods.data[0].id;
  } catch (err) {
    const error = `Failed to list payment methods: ${err instanceof Error ? err.message : String(err)}`;
    await deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
    return { success: false, error };
  }

  // 3. Create off-session PaymentIntent (Stripe expects integer cents)
  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await deps.stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        wopr_tenant: tenantId,
        wopr_source: source,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
    logger.warn("Auto-topup Stripe charge failed", { tenantId, amount: amount.toString(), source, error });
    return { success: false, error };
  }

  // 4. Verify payment succeeded (could be requires_action for 3DS)
  if (paymentIntent.status !== "succeeded") {
    const error = `PaymentIntent status: ${paymentIntent.status}`;
    await deps.eventLogRepo.writeEvent({
      tenantId,
      amountCents,
      status: "failed",
      failureReason: error,
      paymentReference: paymentIntent.id,
    });
    logger.warn("Auto-topup PaymentIntent not succeeded", { tenantId, status: paymentIntent.status });
    return { success: false, error, paymentReference: paymentIntent.id };
  }

  // 5. Credit the ledger (idempotent via referenceId = PI ID)
  try {
    if (!(await deps.creditLedger.hasReferenceId(paymentIntent.id))) {
      await deps.creditLedger.credit(
        tenantId,
        amount,
        "purchase",
        `Auto-topup (${source})`,
        paymentIntent.id,
        "stripe",
      );
    }
  } catch (err) {
    const message = `Stripe charge ${paymentIntent.id} succeeded but credit grant failed: ${err instanceof Error ? err.message : String(err)}`;
    await deps.eventLogRepo
      .writeEvent({
        tenantId,
        amountCents,
        status: "failed",
        failureReason: message,
        paymentReference: paymentIntent.id,
      })
      .catch((logErr) => {
        logger.error("Failed to write failure event after ledger error", { tenantId, piId: paymentIntent.id, logErr });
      });
    logger.error(message, { tenantId, piId: paymentIntent.id, source });
    throw new Error(message);
  }

  // 6. Write success event
  await deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "success", paymentReference: paymentIntent.id });
  logger.info("Auto-topup charge succeeded", { tenantId, amount: amount.toString(), source, piId: paymentIntent.id });

  return { success: true, paymentReference: paymentIntent.id };
}
