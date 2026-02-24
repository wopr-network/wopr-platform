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
 *
 * Note: payment_method_types is omitted to allow dynamic payment methods
 * configured in the Stripe Dashboard. This enables the best payment options
 * for each user's location and preferences.
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
    customer: mapping.processor_customer_id,
    metadata: {
      wopr_tenant: opts.tenant,
    },
  });
}
