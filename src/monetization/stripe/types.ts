/** Tenant-to-Stripe customer mapping stored in SQLite. */
export interface TenantCustomerRow {
  tenant: string;
  stripe_customer_id: string;
  tier: string;
  billing_hold: number;
  inference_mode: string;
  created_at: number;
  updated_at: number;
}

/** Options for creating a Stripe credit purchase Checkout session. */
export interface CreditCheckoutOpts {
  /** Internal tenant ID. */
  tenant: string;
  /** Stripe Price ID for the credit purchase. */
  priceId: string;
  /** URL to redirect to after successful checkout. */
  successUrl: string;
  /** URL to redirect to if the user cancels checkout. */
  cancelUrl: string;
}

/** Options for creating a Stripe Customer Portal session. */
export interface PortalSessionOpts {
  /** Internal tenant ID (used to look up Stripe customer). */
  tenant: string;
  /** URL to redirect to when the user is done managing billing. */
  returnUrl: string;
}

/** Configuration for the Stripe billing integration. */
export interface StripeBillingConfig {
  /** Stripe secret API key. */
  secretKey: string;
  /** Stripe webhook signing secret. */
  webhookSecret: string;
}
