import { describe, expect, it, vi } from "vitest";
import type { SellRateLookupFn } from "./rate-lookup.js";
import { createCachedRateLookup, DEFAULT_TOKEN_RATES, resolveTokenRates } from "./rate-lookup.js";

function makeSellRate(overrides: Partial<{ price_usd: number; unit: string; model: string }> = {}) {
  return {
    id: "test-id",
    capability: "chat-completions",
    display_name: "Test Rate",
    unit: overrides.unit ?? "1K-tokens",
    price_usd: overrides.price_usd ?? 0.01,
    model: overrides.model ?? "test-model",
    is_active: 1,
    sort_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("createCachedRateLookup", () => {
  it("returns cached result on second call (raw lookup called once)", () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockReturnValue(makeSellRate());
    const lookup = createCachedRateLookup(rawLookup);

    lookup("chat-completions", "gpt-4o");
    lookup("chat-completions", "gpt-4o");

    expect(rawLookup).toHaveBeenCalledTimes(1);
  });

  it("re-queries after TTL expires", async () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockReturnValue(makeSellRate());
    // Use a 50ms TTL so the test doesn't need fake timers
    const lookup = createCachedRateLookup(rawLookup, 50);

    lookup("chat-completions", "gpt-4o");
    await new Promise((r) => setTimeout(r, 60)); // wait past TTL
    lookup("chat-completions", "gpt-4o");

    expect(rawLookup).toHaveBeenCalledTimes(2);
  });

  it("caches null results to avoid repeated DB queries for unknown models", () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockReturnValue(null);
    const lookup = createCachedRateLookup(rawLookup);

    lookup("chat-completions", "unknown-model");
    lookup("chat-completions", "unknown-model");

    expect(rawLookup).toHaveBeenCalledTimes(1);
  });

  it("uses separate cache entries for different models", () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockReturnValue(null);
    const lookup = createCachedRateLookup(rawLookup);

    lookup("chat-completions", "model-a");
    lookup("chat-completions", "model-b");

    expect(rawLookup).toHaveBeenCalledTimes(2);
  });
});

describe("resolveTokenRates", () => {
  it("returns defaults when model is undefined", () => {
    const lookupFn: SellRateLookupFn = () => null;
    const rates = resolveTokenRates(lookupFn, "chat-completions", undefined);
    expect(rates).toEqual(DEFAULT_TOKEN_RATES);
  });

  it("returns defaults when lookup returns null", () => {
    const lookupFn: SellRateLookupFn = () => null;
    const rates = resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates).toEqual(DEFAULT_TOKEN_RATES);
  });

  it("uses sell rate price_usd for matching model with blended unit", () => {
    const rate = makeSellRate({
      price_usd: 0.015,
      unit: "1K-tokens",
      model: "anthropic/claude-3.5-sonnet",
    });
    // No unit-specific rows; blended row returned only when no unit filter is passed
    const lookupFn: SellRateLookupFn = (_cap, _model, unit) => (unit ? null : rate);
    const rates = resolveTokenRates(lookupFn, "chat-completions", "anthropic/claude-3.5-sonnet");
    expect(rates.inputRatePer1K).toBe(0.015);
    expect(rates.outputRatePer1K).toBe(0.015); // blended rate applied equally to both
  });

  it("handles unit containing 'input' — sets only inputRatePer1K when no output row exists", () => {
    const inputRate = makeSellRate({ price_usd: 0.015, unit: "1K-input-tokens" });
    // Return input rate for "1K-input-tokens" lookup, null for "1K-output-tokens"
    const lookupFn: SellRateLookupFn = (_cap, _model, unit) => (unit === "1K-input-tokens" ? inputRate : null);
    const rates = resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(0.015);
    expect(rates.outputRatePer1K).toBe(DEFAULT_TOKEN_RATES.outputRatePer1K);
  });

  it("handles unit containing 'output' — sets only outputRatePer1K when no input row exists", () => {
    const outputRate = makeSellRate({ price_usd: 0.075, unit: "1K-output-tokens" });
    // Return output rate for "1K-output-tokens" lookup, null for "1K-input-tokens"
    const lookupFn: SellRateLookupFn = (_cap, _model, unit) => (unit === "1K-output-tokens" ? outputRate : null);
    const rates = resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(DEFAULT_TOKEN_RATES.inputRatePer1K);
    expect(rates.outputRatePer1K).toBe(0.075);
  });

  it("uses separate input and output rates when both direction rows exist", () => {
    const inputRate = makeSellRate({ price_usd: 0.015, unit: "1K-input-tokens" });
    const outputRate = makeSellRate({ price_usd: 0.075, unit: "1K-output-tokens" });
    const lookupFn: SellRateLookupFn = (_cap, _model, unit) => {
      if (unit === "1K-input-tokens") return inputRate;
      if (unit === "1K-output-tokens") return outputRate;
      return null;
    };
    const rates = resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(0.015);
    expect(rates.outputRatePer1K).toBe(0.075);
  });

  it("handles blended rate with single price for both directions", () => {
    const rate = makeSellRate({ price_usd: 0.005, unit: "per-1K-tokens" });
    // No unit-specific rows; blended row returned only when no unit filter is passed
    const lookupFn: SellRateLookupFn = (_cap, _model, unit) => (unit ? null : rate);
    const rates = resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(0.005);
    expect(rates.outputRatePer1K).toBe(0.005); // blended rate applied equally to both
  });
});
