import { describe, expect, it } from "vitest";
import { DEFAULT_MARGIN_CONFIG, getMargin, type MarginConfig, withMarginConfig } from "./margin-config.js";

describe("getMargin", () => {
  const config: MarginConfig = {
    defaultMargin: 1.3,
    rules: [
      { provider: "openrouter", modelPattern: "anthropic/claude-opus-*", margin: 1.15 },
      { provider: "openrouter", modelPattern: "anthropic/claude-haiku-*", margin: 1.5 },
      { provider: "gemini", modelPattern: "gemini-2.5-pro*", margin: 1.2 },
      { provider: "elevenlabs", modelPattern: "*", margin: 1.5 },
    ],
  };

  it("returns correct margin for exact glob prefix match", () => {
    expect(getMargin(config, "openrouter", "anthropic/claude-opus-4")).toBe(1.15);
  });

  it("matches glob pattern with * wildcard", () => {
    expect(getMargin(config, "openrouter", "anthropic/claude-haiku-3.5")).toBe(1.5);
  });

  it("matches pattern with trailing * (no separator)", () => {
    expect(getMargin(config, "gemini", "gemini-2.5-pro-latest")).toBe(1.2);
    expect(getMargin(config, "gemini", "gemini-2.5-pro")).toBe(1.2);
  });

  it("matches wildcard-only pattern (all models for a provider)", () => {
    expect(getMargin(config, "elevenlabs", "eleven_multilingual_v2")).toBe(1.5);
    expect(getMargin(config, "elevenlabs", "any-model-at-all")).toBe(1.5);
  });

  it("first matching rule wins (order matters)", () => {
    const orderedConfig: MarginConfig = {
      defaultMargin: 1.3,
      rules: [
        { provider: "openrouter", modelPattern: "anthropic/claude-opus-*", margin: 1.15 },
        { provider: "openrouter", modelPattern: "anthropic/*", margin: 1.25 },
      ],
    };
    // opus-* matches first even though anthropic/* would also match
    expect(getMargin(orderedConfig, "openrouter", "anthropic/claude-opus-4")).toBe(1.15);
    // non-opus anthropic model matches the second rule
    expect(getMargin(orderedConfig, "openrouter", "anthropic/claude-sonnet-4")).toBe(1.25);
  });

  it("falls back to defaultMargin when no rule matches", () => {
    expect(getMargin(config, "openrouter", "meta/llama-3-70b")).toBe(1.3);
  });

  it("falls back to defaultMargin for unknown provider", () => {
    expect(getMargin(config, "unknown-provider", "some-model")).toBe(1.3);
  });

  it("uses default with empty rules", () => {
    const emptyConfig: MarginConfig = { defaultMargin: 1.4, rules: [] };
    expect(getMargin(emptyConfig, "openrouter", "anthropic/claude-opus-4")).toBe(1.4);
  });

  it("does not match wrong provider even if model pattern matches", () => {
    expect(getMargin(config, "gemini", "anthropic/claude-opus-4")).toBe(1.3);
  });
});

describe("withMarginConfig", () => {
  const config: MarginConfig = {
    defaultMargin: 1.3,
    rules: [
      { provider: "openrouter", modelPattern: "anthropic/claude-opus-*", margin: 1.15 },
      { provider: "openrouter", modelPattern: "anthropic/claude-haiku-*", margin: 1.5 },
    ],
  };

  it("applies correct margin for matching rule", () => {
    // cost 1.0 * margin 1.15 = 1.15
    expect(withMarginConfig(1.0, config, "openrouter", "anthropic/claude-opus-4")).toBe(1.15);
  });

  it("applies correct margin for a different matching rule", () => {
    // cost 1.0 * margin 1.5 = 1.5
    expect(withMarginConfig(1.0, config, "openrouter", "anthropic/claude-haiku-3.5")).toBe(1.5);
  });

  it("falls back to default margin when no rule matches", () => {
    // cost 1.0 * default 1.3 = 1.3
    expect(withMarginConfig(1.0, config, "openrouter", "meta/llama-3-70b")).toBe(1.3);
  });

  it("handles fractional costs with 6 decimal precision", () => {
    // cost 0.000123 * margin 1.15 = 0.00014145
    const result = withMarginConfig(0.000123, config, "openrouter", "anthropic/claude-opus-4");
    expect(result).toBeCloseTo(0.00014145, 6);
  });

  it("handles zero cost", () => {
    expect(withMarginConfig(0, config, "openrouter", "anthropic/claude-opus-4")).toBe(0);
  });
});

describe("DEFAULT_MARGIN_CONFIG", () => {
  it("has a default margin of 1.3", () => {
    expect(DEFAULT_MARGIN_CONFIG.defaultMargin).toBe(1.3);
  });

  it("has rules for openrouter, gemini, elevenlabs, and deepgram", () => {
    const providers = new Set(DEFAULT_MARGIN_CONFIG.rules.map((r) => r.provider));
    expect(providers).toContain("openrouter");
    expect(providers).toContain("gemini");
    expect(providers).toContain("elevenlabs");
    expect(providers).toContain("deepgram");
  });

  it("gives expensive models lower margins than cheap models", () => {
    const opusMargin = getMargin(DEFAULT_MARGIN_CONFIG, "openrouter", "anthropic/claude-opus-4");
    const haikuMargin = getMargin(DEFAULT_MARGIN_CONFIG, "openrouter", "anthropic/claude-haiku-3.5");
    expect(opusMargin).toBeLessThan(haikuMargin);
  });
});
