/**
 * WOPR Credit price points and bonus tiers.
 *
 * One Stripe Product ("WOPR Credits") with 5 preset Price objects.
 * Each price maps to a dollar amount and a credit value (with optional bonus).
 *
 * Price IDs are loaded from environment variables so they can differ
 * between Stripe test/live modes.
 */

/** A preset credit purchase option. */
export interface CreditPricePoint {
  /** Human-readable label. */
  label: string;
  /** Amount charged in cents (USD). */
  amountCredits: number;
  /** Credits granted in cents (includes bonus). */
  creditCents: number;
  /** Bonus percentage (0 for no bonus). */
  bonusPercent: number;
}

/**
 * The 5 preset credit tiers.
 *
 * Bonus logic:
 *   $5   -> $5.00 credit   (0% bonus)
 *   $10  -> $10.00 credit  (0% bonus)
 *   $25  -> $25.50 credit  (2% bonus)
 *   $50  -> $52.50 credit  (5% bonus)
 *   $100 -> $110.00 credit (10% bonus)
 */
export const CREDIT_PRICE_POINTS: readonly CreditPricePoint[] = [
  { label: "$5", amountCredits: 500, creditCents: 500, bonusPercent: 0 },
  { label: "$10", amountCredits: 1000, creditCents: 1000, bonusPercent: 0 },
  { label: "$25", amountCredits: 2500, creditCents: 2550, bonusPercent: 2 },
  { label: "$50", amountCredits: 5000, creditCents: 5250, bonusPercent: 5 },
  { label: "$100", amountCredits: 10000, creditCents: 11000, bonusPercent: 10 },
] as const;

/**
 * Map of env var name -> index into CREDIT_PRICE_POINTS.
 * Each env var holds the Stripe Price ID for that tier.
 */
const PRICE_ENV_VARS = [
  "STRIPE_CREDIT_PRICE_5",
  "STRIPE_CREDIT_PRICE_10",
  "STRIPE_CREDIT_PRICE_25",
  "STRIPE_CREDIT_PRICE_50",
  "STRIPE_CREDIT_PRICE_100",
] as const;

/** Mapping from Stripe Price ID -> CreditPricePoint. */
export type CreditPriceMap = ReadonlyMap<string, CreditPricePoint>;

/**
 * Load credit price mappings from environment variables.
 *
 * Returns a Map from Stripe Price ID -> CreditPricePoint.
 * Only includes entries where the env var is set.
 */
export function loadCreditPriceMap(): CreditPriceMap {
  const map = new Map<string, CreditPricePoint>();

  for (let i = 0; i < PRICE_ENV_VARS.length; i++) {
    const priceId = process.env[PRICE_ENV_VARS[i]];
    if (priceId) {
      map.set(priceId, CREDIT_PRICE_POINTS[i]);
    }
  }

  return map;
}

/**
 * Get the credit amount (in cents) for a given purchase amount (in cents).
 *
 * Uses the bonus tiers to determine the credit value.
 * Falls back to 1:1 if no matching tier is found.
 */
export function getCreditAmountForPurchase(amountCredits: number): number {
  const tier = CREDIT_PRICE_POINTS.find((p) => p.amountCredits === amountCredits);
  return tier ? tier.creditCents : amountCredits;
}

/**
 * Look up a CreditPricePoint by Stripe Price ID using the price map.
 * Returns null if the price ID is not recognized.
 */
export function lookupCreditPrice(priceMap: CreditPriceMap, priceId: string): CreditPricePoint | null {
  return priceMap.get(priceId) ?? null;
}

/** Get all configured Stripe Price IDs (for validation). */
export function getConfiguredPriceIds(): string[] {
  const ids: string[] = [];
  for (const envVar of PRICE_ENV_VARS) {
    const priceId = process.env[envVar];
    if (priceId) {
      ids.push(priceId);
    }
  }
  return ids;
}
