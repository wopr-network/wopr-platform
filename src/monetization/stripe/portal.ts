import type Stripe from "stripe";
import type { TenantCustomerRepository } from "../../domain/repositories/tenant-customer-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import type { PortalSessionOpts } from "./types.js";

/**
 * Create a Stripe Customer Portal session so the user can manage their billing.
 *
 * Users can update payment methods, view invoices, cancel subscriptions, etc.
 * All via Stripe's hosted UI -- zero billing UI code in WOPR.
 */
export async function createPortalSession(
  stripe: Stripe,
  tenantRepo: TenantCustomerRepository,
  opts: PortalSessionOpts,
): Promise<Stripe.BillingPortal.Session> {
  const mapping = await tenantRepo.getByTenant(TenantId.create(opts.tenant));
  if (!mapping) {
    throw new Error(`No Stripe customer found for tenant: ${opts.tenant}`);
  }

  return stripe.billingPortal.sessions.create({
    customer: mapping.stripeCustomerId,
    return_url: opts.returnUrl,
  });
}
