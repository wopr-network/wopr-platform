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
 */
export type SellRateLookupFn = (capability: string, model: string) => SellRate | null;

/**
 * Create a cached sell-rate lookup function.
 *
 * Wraps a raw DB lookup with an LRU cache that has a 5-minute TTL.
 * Cache key: `${capability}:${model}`.
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

  return (capability: string, model: string): SellRate | null => {
    const key = `${capability}:${model}`;
    if (cache.has(key)) {
      const cached = cache.get(key);
      return cached === MISS || cached === undefined ? null : cached;
    }
    const result = rawLookup(capability, model);
    cache.set(key, result ?? MISS);
    return result;
  };
}

/**
 * Resolve token rates for a given model by looking up the sell_rates table.
 *
 * Lookup strategy:
 * 1. Try exact model match: capability="chat-completions", model=<model>
 * 2. If no match, return DEFAULT_TOKEN_RATES
 *
 * The sell_rates table stores `price_usd` per `unit`. For token-based rates,
 * `unit` may be "1K-input-tokens", "1K-output-tokens", or a blended "1K-tokens".
 * If only a single blended rate exists, use price_usd for input and price_usd*2 for output.
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

  const rate = lookupFn(capability, model);
  if (!rate) return DEFAULT_TOKEN_RATES;

  if (rate.unit.includes("input")) {
    return { inputRatePer1K: rate.price_usd, outputRatePer1K: DEFAULT_TOKEN_RATES.outputRatePer1K };
  }
  if (rate.unit.includes("output")) {
    return { inputRatePer1K: DEFAULT_TOKEN_RATES.inputRatePer1K, outputRatePer1K: rate.price_usd };
  }

  // Single blended rate — apply to both input and output tokens.
  // TODO: add separate "1K-input-tokens" / "1K-output-tokens" rows per model in sell_rates
  // to correctly reflect models with non-1:1 output ratios (e.g., Claude Opus 4 is 5:1).
  // Using the blended rate for both avoids the incorrect 2x assumption that was here before.
  return {
    inputRatePer1K: rate.price_usd,
    outputRatePer1K: rate.price_usd,
  };
}
