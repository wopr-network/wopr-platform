import type Stripe from "stripe";
import type { ITenantCustomerStore, TenantCustomerStore } from "./tenant-store.js";

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
  const mapping = await tenantStore.getByTenant(opts.tenant);
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

/**
 * Detach ALL payment methods from a tenant's Stripe customer.
 *
 * Used during ban cascade to prevent any future charges.
 * Returns the number of payment methods detached.
 * Returns 0 (does not throw) if tenant has no Stripe customer or no methods.
 */
export async function detachAllPaymentMethods(
  stripe: Stripe,
  tenantStore: ITenantCustomerStore,
  tenantId: string,
): Promise<number> {
  const mapping = await tenantStore.getByTenant(tenantId);
  if (!mapping) return 0;

  let detached = 0;
  let startingAfter: string | undefined;

  while (true) {
    const methods = await stripe.customers.listPaymentMethods(mapping.processor_customer_id, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const pm of methods.data) {
      await stripe.paymentMethods.detach(pm.id);
      detached++;
    }

    if (!methods.has_more) break;
    startingAfter = methods.data[methods.data.length - 1].id;
  }

  return detached;
}
