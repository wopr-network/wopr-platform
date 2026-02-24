import type Stripe from "stripe";
import type { ITenantCustomerStore, TenantCustomerStore } from "./tenant-store.js";
import type { CreditCheckoutOpts, VpsCheckoutOpts } from "./types.js";

/**
 * Create a Stripe Checkout session for a one-time credit purchase.
 *
 * Uses mode: "payment" (not "subscription") — credits are purchased
 * as one-time payments and credited to the tenant's ledger via webhook.
 *
 * If the tenant already has a Stripe customer, it reuses that customer.
 * Otherwise, Stripe creates a new customer during checkout.
 */
export async function createCreditCheckoutSession(
  stripe: Stripe,
  tenantStore: TenantCustomerStore,
  opts: CreditCheckoutOpts,
): Promise<Stripe.Checkout.Session> {
  const existing = tenantStore.getByTenant(opts.tenant);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: [
      {
        price: opts.priceId,
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.tenant,
    metadata: {
      wopr_tenant: opts.tenant,
      wopr_purchase_type: "credits",
    },
  };

  // Reuse existing Stripe customer if we have one.
  if (existing) {
    params.customer = existing.processor_customer_id;
  }

  return stripe.checkout.sessions.create(params);
}

/**
 * Create a Stripe Checkout session for a VPS subscription.
 *
 * Uses mode: "subscription" — VPS is a $15/month recurring subscription.
 * The webhook handler processes customer.subscription.created to activate VPS status.
 */
export async function createVpsCheckoutSession(
  stripe: Stripe,
  tenantStore: ITenantCustomerStore,
  opts: VpsCheckoutOpts,
): Promise<Stripe.Checkout.Session> {
  const existing = tenantStore.getByTenant(opts.tenant);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [
      {
        price: opts.vpsPriceId,
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.tenant,
    metadata: {
      wopr_tenant: opts.tenant,
      wopr_bot_id: opts.botId,
      wopr_purchase_type: "vps",
    },
  };

  if (existing) {
    params.customer = existing.processor_customer_id;
  }

  return stripe.checkout.sessions.create(params);
}
