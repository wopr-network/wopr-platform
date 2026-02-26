import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";
import type { PortalSessionOpts } from "./types.js";

/**
 * Create a Stripe Customer Portal session so the user can manage their billing.
 *
 * Users can update payment methods, view invoices, cancel subscriptions, etc.
 * All via Stripe's hosted UI -- zero billing UI code in WOPR.
 */
export async function createPortalSession(
  stripe: Stripe,
  tenantStore: TenantCustomerStore,
  opts: PortalSessionOpts,
): Promise<Stripe.BillingPortal.Session> {
  const mapping = await tenantStore.getByTenant(opts.tenant);
  if (!mapping) {
    throw new Error(`No Stripe customer found for tenant: ${opts.tenant}`);
  }

  return stripe.billingPortal.sessions.create({
    customer: mapping.processor_customer_id,
    return_url: opts.returnUrl,
  });
}
