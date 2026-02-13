/** Tenant-to-Stripe customer mapping stored in SQLite. */
export interface TenantCustomerRow {
  tenant: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  tier: string;
  created_at: number;
  updated_at: number;
}

/** Tracks which billing period summaries have been reported to Stripe. */
export interface StripeUsageReportRow {
  id: string;
  tenant: string;
  capability: string;
  provider: string;
  period_start: number;
  period_end: number;
  /** The Stripe meter event name used. */
  event_name: string;
  /** Charge in cents reported to Stripe. */
  value_cents: number;
  /** Unix epoch ms when this row was reported. */
  reported_at: number;
}

/** Options for creating a Stripe Checkout session. */
export interface CheckoutSessionOpts {
  /** Internal tenant ID. */
  tenant: string;
  /** Stripe Price ID for the usage-based subscription. */
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
  /** Default Stripe Price ID for usage-based subscriptions. */
  defaultPriceId?: string;
}
