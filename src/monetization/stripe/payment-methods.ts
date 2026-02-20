import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";

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
  if (pm.customer !== mapping.stripe_customer_id) {
    throw new Error("Payment method does not belong to this tenant");
  }

  await stripe.paymentMethods.detach(opts.paymentMethodId);
}
