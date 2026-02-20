import { LRUCache } from "lru-cache";
import type { SellRate } from "../admin/rates/rate-store.js";

/**
 * Token rates (per 1K tokens) for metering.
 */
export interface TokenRates {
  inputRatePer1K: number;
  outputRatePer1K: number;
}

/** Default fallback rates (GPT-3.5-turbo level). */
export const DEFAULT_TOKEN_RATES: TokenRates = {
  inputRatePer1K: 0.001,
  outputRatePer1K: 0.002,
};

/**
 * Function signature for looking up sell rates by capability and model.
 * Abstracts the DB dependency so streaming.ts doesn't import RateStore directly.
 * Optional `unit` parameter allows filtering to a specific unit (e.g., "1K-input-tokens").
 */
export type SellRateLookupFn = (capability: string, model: string, unit?: string) => SellRate | null;

/**
 * Create a cached sell-rate lookup function.
 *
 * Wraps a raw DB lookup with an LRU cache that has a 5-minute TTL.
 * Cache key: `${capability}:${model}:${unit ?? ""}` so input and output rates cache independently.
 *
 * @param rawLookup - Function that queries the sell_rates table for a given capability+model.
 * @returns Cached lookup function
 */
/** Sentinel value used to cache "no rate found" results without storing null. */
const MISS = Symbol("miss");

export function createCachedRateLookup(rawLookup: SellRateLookupFn, ttlMs = 5 * 60 * 1000): SellRateLookupFn {
  const cache = new LRUCache<string, SellRate | typeof MISS>({
    max: 200,
    ttl: ttlMs,
  });

  return (capability: string, model: string, unit?: string): SellRate | null => {
    const key = `${capability}:${model}:${unit ?? ""}`;
    if (cache.has(key)) {
      const cached = cache.get(key);
      return cached === MISS || cached === undefined ? null : cached;
    }
    const result = rawLookup(capability, model, unit);
    cache.set(key, result ?? MISS);
    return result;
  };
}

/**
 * Resolve token rates for a given model by looking up the sell_rates table.
 *
 * Lookup strategy:
 * 1. Perform two independent lookups — one for "1K-input-tokens" and one for "1K-output-tokens".
 * 2. If a direction-specific row is found, use its price_usd for that direction.
 * 3. If no direction-specific row is found, fall back to a blended lookup (no unit filter).
 * 4. If still no match, return DEFAULT_TOKEN_RATES for that direction.
 *
 * The sell_rates table stores `price_usd` per `unit`. For token-based rates,
 * `unit` may be "1K-input-tokens", "1K-output-tokens", or a blended "1K-tokens".
 *
 * @param lookupFn - Cached sell rate lookup function
 * @param capability - e.g., "chat-completions"
 * @param model - e.g., "anthropic/claude-3.5-sonnet"
 * @returns Token rates for metering
 */
export function resolveTokenRates(
  lookupFn: SellRateLookupFn,
  capability: string,
  model: string | undefined,
): TokenRates {
  if (!model) return DEFAULT_TOKEN_RATES;

  // Perform two independent lookups so models with separate input/output rows are handled correctly.
  const inputRate = lookupFn(capability, model, "1K-input-tokens");
  const outputRate = lookupFn(capability, model, "1K-output-tokens");

  if (inputRate || outputRate) {
    return {
      inputRatePer1K: inputRate ? inputRate.price_usd : DEFAULT_TOKEN_RATES.inputRatePer1K,
      outputRatePer1K: outputRate ? outputRate.price_usd : DEFAULT_TOKEN_RATES.outputRatePer1K,
    };
  }

  // Fall back to a blended rate row (no unit filter).
  const blended = lookupFn(capability, model);
  if (!blended) return DEFAULT_TOKEN_RATES;

  // Single blended rate — apply to both input and output tokens.
  // Using the blended rate for both avoids the incorrect 2x assumption.
  return {
    inputRatePer1K: blended.price_usd,
    outputRatePer1K: blended.price_usd,
  };
}
