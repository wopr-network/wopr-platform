import { describe, expect, it, vi } from "vitest";
import { logger } from "../config/logger.js";
import type { SellRateLookupFn } from "./rate-lookup.js";
import { createCachedRateLookup, DEFAULT_TOKEN_RATES, resolveTokenRates } from "./rate-lookup.js";

vi.mock("../config/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
  it("returns cached result on second call (raw lookup called once)", async () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockResolvedValue(makeSellRate());
    const lookup = createCachedRateLookup(rawLookup);

    await lookup("chat-completions", "gpt-4o");
    await lookup("chat-completions", "gpt-4o");

    expect(rawLookup).toHaveBeenCalledTimes(1);
  });

  it("re-queries after TTL expires", async () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockResolvedValue(makeSellRate());
    // Use a 50ms TTL so the test doesn't need fake timers
    const lookup = createCachedRateLookup(rawLookup, 50);

    await lookup("chat-completions", "gpt-4o");
    await new Promise((r) => setTimeout(r, 60)); // wait past TTL
    await lookup("chat-completions", "gpt-4o");

    expect(rawLookup).toHaveBeenCalledTimes(2);
  });

  it("caches null results to avoid repeated DB queries for unknown models", async () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockResolvedValue(null);
    const lookup = createCachedRateLookup(rawLookup);

    await lookup("chat-completions", "unknown-model");
    await lookup("chat-completions", "unknown-model");

    expect(rawLookup).toHaveBeenCalledTimes(1);
  });

  it("uses separate cache entries for different models", async () => {
    const rawLookup = vi.fn<SellRateLookupFn>().mockResolvedValue(null);
    const lookup = createCachedRateLookup(rawLookup);

    await lookup("chat-completions", "model-a");
    await lookup("chat-completions", "model-b");

    expect(rawLookup).toHaveBeenCalledTimes(2);
  });
});

describe("resolveTokenRates", () => {
  it("returns defaults when model is undefined", async () => {
    const lookupFn: SellRateLookupFn = async () => null;
    const rates = await resolveTokenRates(lookupFn, "chat-completions", undefined);
    expect(rates).toEqual(DEFAULT_TOKEN_RATES);
  });

  it("returns defaults when lookup returns null", async () => {
    const lookupFn: SellRateLookupFn = async () => null;
    const rates = await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates).toEqual(DEFAULT_TOKEN_RATES);
  });

  it("uses sell rate price_usd for matching model with blended unit", async () => {
    const rate = makeSellRate({
      price_usd: 0.015,
      unit: "1K-tokens",
      model: "anthropic/claude-3.5-sonnet",
    });
    // No unit-specific rows; blended row returned only when no unit filter is passed
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => (unit ? null : rate);
    const rates = await resolveTokenRates(lookupFn, "chat-completions", "anthropic/claude-3.5-sonnet");
    expect(rates.inputRatePer1K).toBe(0.015);
    expect(rates.outputRatePer1K).toBe(0.015); // blended rate applied equally to both
  });

  it("handles unit containing 'input' — sets only inputRatePer1K when no output row exists", async () => {
    const inputRate = makeSellRate({ price_usd: 0.015, unit: "1K-input-tokens" });
    // Return input rate for "1K-input-tokens" lookup, null for "1K-output-tokens"
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => (unit === "1K-input-tokens" ? inputRate : null);
    const rates = await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(0.015);
    expect(rates.outputRatePer1K).toBe(DEFAULT_TOKEN_RATES.outputRatePer1K);
  });

  it("handles unit containing 'output' — sets only outputRatePer1K when no input row exists", async () => {
    const outputRate = makeSellRate({ price_usd: 0.075, unit: "1K-output-tokens" });
    // Return output rate for "1K-output-tokens" lookup, null for "1K-input-tokens"
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => (unit === "1K-output-tokens" ? outputRate : null);
    const rates = await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(DEFAULT_TOKEN_RATES.inputRatePer1K);
    expect(rates.outputRatePer1K).toBe(0.075);
  });

  it("uses separate input and output rates when both direction rows exist", async () => {
    const inputRate = makeSellRate({ price_usd: 0.015, unit: "1K-input-tokens" });
    const outputRate = makeSellRate({ price_usd: 0.075, unit: "1K-output-tokens" });
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => {
      if (unit === "1K-input-tokens") return inputRate;
      if (unit === "1K-output-tokens") return outputRate;
      return null;
    };
    const rates = await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(0.015);
    expect(rates.outputRatePer1K).toBe(0.075);
  });

  it("handles blended rate with single price for both directions", async () => {
    const rate = makeSellRate({ price_usd: 0.005, unit: "per-1K-tokens" });
    // No unit-specific rows; blended row returned only when no unit filter is passed
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => (unit ? null : rate);
    const rates = await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(rates.inputRatePer1K).toBe(0.005);
    expect(rates.outputRatePer1K).toBe(0.005); // blended rate applied equally to both
  });

  it("logs a warning when no sell rate exists for a known model", async () => {
    vi.mocked(logger.warn).mockClear();
    const lookupFn: SellRateLookupFn = async () => null;
    await resolveTokenRates(lookupFn, "chat-completions", "anthropic/claude-3.5-sonnet");
    expect(logger.warn).toHaveBeenCalledWith(
      "No sell rate found for model — using default fallback rates",
      expect.objectContaining({
        capability: "chat-completions",
        model: "anthropic/claude-3.5-sonnet",
      }),
    );
  });

  it("logs a warning when only input rate exists but not output rate", async () => {
    vi.mocked(logger.warn).mockClear();
    const inputRate = makeSellRate({ price_usd: 0.015, unit: "1K-input-tokens" });
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => (unit === "1K-input-tokens" ? inputRate : null);
    await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(logger.warn).toHaveBeenCalledWith(
      "No output sell rate found for model — using default for output direction",
      expect.objectContaining({
        capability: "chat-completions",
        model: "some-model",
      }),
    );
  });

  it("does not log a warning when model is undefined", async () => {
    vi.mocked(logger.warn).mockClear();
    const lookupFn: SellRateLookupFn = async () => null;
    await resolveTokenRates(lookupFn, "chat-completions", undefined);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not log a warning when both direction rates are found", async () => {
    vi.mocked(logger.warn).mockClear();
    const inputRate = makeSellRate({ price_usd: 0.015, unit: "1K-input-tokens" });
    const outputRate = makeSellRate({ price_usd: 0.075, unit: "1K-output-tokens" });
    const lookupFn: SellRateLookupFn = async (_cap, _model, unit) => {
      if (unit === "1K-input-tokens") return inputRate;
      if (unit === "1K-output-tokens") return outputRate;
      return null;
    };
    await resolveTokenRates(lookupFn, "chat-completions", "some-model");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
