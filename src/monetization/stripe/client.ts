import Stripe from "stripe";
import type { StripeBillingConfig } from "./types.js";

/**
 * The Stripe API version to use for all requests.
 * Pinning this ensures stability across Stripe API releases.
 */
const STRIPE_API_VERSION = "2024-12-18.acacia" as Stripe.LatestApiVersion;

/**
 * Create a configured Stripe client.
 *
 * All Stripe config comes from env vars — no billing logic in WOPR,
 * just a thin wrapper around the Stripe SDK.
 */
export function createStripeClient(config: StripeBillingConfig): Stripe {
  return new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
  });
}

/**
 * Load Stripe billing config from environment variables.
 * Returns null if required vars are missing.
 */
export function loadStripeConfig(): StripeBillingConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    return null;
  }

  return {
    secretKey,
    webhookSecret,
  };
}
