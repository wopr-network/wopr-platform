import { describe, expect, it } from "vitest";
import { computeInferenceCost } from "./inference-cost.js";

describe("computeInferenceCost", () => {
  it("computes cost for Claude Sonnet with no caching", () => {
    const cost = computeInferenceCost({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
    // Sonnet: $3/M input, $15/M output
    // (1000 * 3/1e6) + (200 * 15/1e6) = 0.003 + 0.003 = 0.006
    expect(cost).toBeCloseTo(0.006);
  });

  it("applies cache read discount (10% of input price)", () => {
    const cost = computeInferenceCost({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 800,
      cacheWriteTokens: 0,
    });
    // Non-cached input: 200 tokens * $3/M = 0.0006
    // Cached read: 800 tokens * $0.30/M = 0.00024
    // Output: 200 tokens * $15/M = 0.003
    // Total: 0.0006 + 0.00024 + 0.003 = 0.00384
    expect(cost).toBeCloseTo(0.00384);
  });

  it("applies cache write surcharge (125% of input price)", () => {
    const cost = computeInferenceCost({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 500,
    });
    // Non-cached input: 500 tokens * $3/M = 0.0015
    // Cache write: 500 tokens * $3.75/M = 0.001875
    // Output: 100 tokens * $15/M = 0.0015
    // Total: 0.0015 + 0.001875 + 0.0015 = 0.004875
    expect(cost).toBeCloseTo(0.004875);
  });

  it("returns 0 for unknown model (fallback to OpenRouter cost header)", () => {
    const cost = computeInferenceCost({
      model: "unknown-model-v9",
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(0);
  });
});
