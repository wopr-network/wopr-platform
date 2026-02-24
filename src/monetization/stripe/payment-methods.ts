import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";

export class PaymentMethodOwnershipError extends Error {
  readonly code = "PAYMENT_METHOD_NOT_OWNED" as const;
  constructor() {
    super("Payment method does not belong to this tenant");
    this.name = "PaymentMethodOwnershipError";
  }
}

export interface DetachPaymentMethodOpts {
  tenant: string;
  paymentMethodId: string;
}

/**
 * Detach a payment method from a Stripe customer.
 *
 * Validates the payment method belongs to the tenant's Stripe customer
 * before detaching to prevent cross-tenant attacks.
 */
export async function detachPaymentMethod(
  stripe: Stripe,
  tenantStore: TenantCustomerStore,
  opts: DetachPaymentMethodOpts,
): Promise<void> {
  const mapping = tenantStore.getByTenant(opts.tenant);
  if (!mapping) {
    throw new Error(`No Stripe customer found for tenant: ${opts.tenant}`);
  }

  // Retrieve the payment method to verify it belongs to this customer
  const pm = await stripe.paymentMethods.retrieve(opts.paymentMethodId);
  if (!pm.customer || pm.customer !== mapping.processor_customer_id) {
    throw new PaymentMethodOwnershipError();
  }

  await stripe.paymentMethods.detach(opts.paymentMethodId);
}
