import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";

export interface SetupIntentOpts {
  tenant: string;
}

/**
 * Create a Stripe SetupIntent so the user can save a payment method.
 *
 * Requires an existing Stripe customer (created during credit checkout).
 * Returns the client_secret for use with Stripe Elements on the frontend.
 */
export async function createSetupIntent(
  stripe: Stripe,
  tenantStore: TenantCustomerStore,
  opts: SetupIntentOpts,
): Promise<Stripe.SetupIntent> {
  const mapping = tenantStore.getByTenant(opts.tenant);
  if (!mapping) {
    throw new Error(`No Stripe customer found for tenant: ${opts.tenant}`);
  }

  return stripe.setupIntents.create({
    customer: mapping.stripe_customer_id,
    payment_method_types: ["card"],
    metadata: {
      wopr_tenant: opts.tenant,
    },
  });
}
