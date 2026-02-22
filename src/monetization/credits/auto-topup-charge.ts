import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
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
  amountCents: number,
  source: string,
): Promise<AutoTopupChargeResult> {
  // 1. Look up Stripe customer
  const mapping = deps.tenantStore.getByTenant(tenantId);
  if (!mapping) {
    const error = `No Stripe customer for tenant ${tenantId}`;
    deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
    return { success: false, error };
  }

  const customerId = mapping.stripe_customer_id;

  // 2. Get default payment method
  let paymentMethodId: string;
  try {
    const methods = await deps.stripe.customers.listPaymentMethods(customerId, { limit: 1 });
    if (!methods.data.length) {
      const error = `No payment method on file for tenant ${tenantId}`;
      deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
      return { success: false, error };
    }
    paymentMethodId = methods.data[0].id;
  } catch (err) {
    const error = `Failed to list payment methods: ${err instanceof Error ? err.message : String(err)}`;
    deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
    return { success: false, error };
  }

  // 3. Create off-session PaymentIntent
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
    deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "failed", failureReason: error });
    logger.warn("Auto-topup Stripe charge failed", { tenantId, amountCents, source, error });
    return { success: false, error };
  }

  // 4. Verify payment succeeded (could be requires_action for 3DS)
  if (paymentIntent.status !== "succeeded") {
    const error = `PaymentIntent status: ${paymentIntent.status}`;
    deps.eventLogRepo.writeEvent({
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
  if (!deps.creditLedger.hasReferenceId(paymentIntent.id)) {
    deps.creditLedger.credit(tenantId, amountCents, "purchase", `Auto-topup (${source})`, paymentIntent.id, "stripe");
  }

  // 6. Write success event
  deps.eventLogRepo.writeEvent({ tenantId, amountCents, status: "success", paymentReference: paymentIntent.id });
  logger.info("Auto-topup charge succeeded", { tenantId, amountCents, source, piId: paymentIntent.id });

  return { success: true, paymentReference: paymentIntent.id };
}
