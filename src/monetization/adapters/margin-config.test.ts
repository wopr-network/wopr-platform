import { describe, expect, it, vi } from "vitest";
import { Credit } from "../credit.js";
import { getMargin, loadMarginConfig, type MarginConfig, withMarginConfig } from "./margin-config.js";

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
    expect(
      withMarginConfig(Credit.fromDollars(1.0), config, "openrouter", "anthropic/claude-opus-4").toDollars(),
    ).toBeCloseTo(1.15, 6);
  });

  it("applies correct margin for a different matching rule", () => {
    // cost 1.0 * margin 1.5 = 1.5
    expect(
      withMarginConfig(Credit.fromDollars(1.0), config, "openrouter", "anthropic/claude-haiku-3.5").toDollars(),
    ).toBeCloseTo(1.5, 6);
  });

  it("falls back to default margin when no rule matches", () => {
    // cost 1.0 * default 1.3 = 1.3
    expect(withMarginConfig(Credit.fromDollars(1.0), config, "openrouter", "meta/llama-3-70b").toDollars()).toBeCloseTo(
      1.3,
      6,
    );
  });

  it("handles fractional costs with 6 decimal precision", () => {
    // cost 0.000123 * margin 1.15 = 0.00014145
    const result = withMarginConfig(Credit.fromDollars(0.000123), config, "openrouter", "anthropic/claude-opus-4");
    expect(result.toDollars()).toBeCloseTo(0.00014145, 6);
  });

  it("handles zero cost", () => {
    expect(withMarginConfig(Credit.ZERO, config, "openrouter", "anthropic/claude-opus-4").isZero()).toBe(true);
  });
});

describe("loadMarginConfig", () => {
  it("returns flat 1.3x default with empty rules when MARGIN_CONFIG_JSON is unset", () => {
    vi.stubEnv("MARGIN_CONFIG_JSON", undefined);
    const config = loadMarginConfig();
    expect(config.defaultMargin).toBe(1.3);
    expect(config.rules).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("parses MARGIN_CONFIG_JSON when set", () => {
    const margin = { defaultMargin: 1.25, rules: [{ provider: "elevenlabs", modelPattern: "*", margin: 1.6 }] };
    vi.stubEnv("MARGIN_CONFIG_JSON", JSON.stringify(margin));
    const config = loadMarginConfig();
    expect(config.defaultMargin).toBe(1.25);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].margin).toBe(1.6);
    vi.unstubAllEnvs();
  });

  it("throws on invalid JSON", () => {
    vi.stubEnv("MARGIN_CONFIG_JSON", "{not valid json}");
    expect(() => loadMarginConfig()).toThrow("MARGIN_CONFIG_JSON is set but is not valid JSON");
    vi.unstubAllEnvs();
  });
});
