import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";
import type { CheckoutSessionOpts } from "./types.js";

/**
 * Create a Stripe Checkout session for a tenant to sign up for a usage-based plan.
 *
 * If the tenant already has a Stripe customer, it reuses that customer.
 * Otherwise, Stripe creates a new customer during checkout.
 */
export async function createCheckoutSession(
  stripe: Stripe,
  tenantStore: TenantCustomerStore,
  opts: CheckoutSessionOpts,
): Promise<Stripe.Checkout.Session> {
  const existing = tenantStore.getByTenant(opts.tenant);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [
      {
        price: opts.priceId,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.tenant,
    metadata: {
      wopr_tenant: opts.tenant,
    },
  };

  // Reuse existing Stripe customer if we have one.
  if (existing) {
    params.customer = existing.stripe_customer_id;
  }

  return stripe.checkout.sessions.create(params);
}
