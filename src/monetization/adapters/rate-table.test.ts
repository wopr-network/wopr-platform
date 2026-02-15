import { describe, expect, it } from "vitest";
import { calculateSavings, getRatesForCapability, lookupRate, RATE_TABLE } from "./rate-table.js";

describe("RATE_TABLE", () => {
  it("contains both standard and premium tiers for TTS", () => {
    const standardTTS = RATE_TABLE.find((e) => e.capability === "tts" && e.tier === "standard");
    const premiumTTS = RATE_TABLE.find((e) => e.capability === "tts" && e.tier === "premium");

    expect(standardTTS).toBeDefined();
    expect(premiumTTS).toBeDefined();
  });

  it("standard tier is cheaper than premium tier for same capability", () => {
    const standardTTS = RATE_TABLE.find((e) => e.capability === "tts" && e.tier === "standard");
    const premiumTTS = RATE_TABLE.find((e) => e.capability === "tts" && e.tier === "premium");

    expect(standardTTS?.effectivePrice).toBeLessThan(premiumTTS?.effectivePrice ?? Infinity);
  });

  it("effective price equals cost * margin", () => {
    for (const entry of RATE_TABLE) {
      const expectedEffectivePrice = entry.costPerUnit * entry.margin;
      expect(entry.effectivePrice).toBeCloseTo(expectedEffectivePrice, 8);
    }
  });

  it("standard tier uses self-hosted providers", () => {
    const standardEntries = RATE_TABLE.filter((e) => e.tier === "standard");

    for (const entry of standardEntries) {
      // Self-hosted providers include "self-hosted-" prefix or are known self-hosted names
      const isSelfHosted =
        entry.provider.startsWith("self-hosted-") || entry.provider === "chatterbox-tts";
      expect(isSelfHosted).toBe(true);
    }
  });

  it("premium tier uses third-party providers", () => {
    const premiumEntries = RATE_TABLE.filter((e) => e.tier === "premium");

    for (const entry of premiumEntries) {
      // Third-party providers are well-known brand names
      const isThirdParty = ["elevenlabs", "deepgram", "openrouter", "replicate", "gemini"].includes(
        entry.provider,
      );
      expect(isThirdParty).toBe(true);
    }
  });

  it("standard tier has lower margins than premium tier", () => {
    const capabilities = new Set(RATE_TABLE.map((e) => e.capability));

    for (const capability of capabilities) {
      const standard = RATE_TABLE.find((e) => e.capability === capability && e.tier === "standard");
      const premium = RATE_TABLE.find((e) => e.capability === capability && e.tier === "premium");

      if (standard && premium) {
        expect(standard.margin).toBeLessThan(premium.margin);
      }
    }
  });
});

describe("lookupRate", () => {
  it("finds standard tier TTS rate", () => {
    const rate = lookupRate("tts", "standard");
    expect(rate).toBeDefined();
    expect(rate?.capability).toBe("tts");
    expect(rate?.tier).toBe("standard");
    expect(rate?.provider).toBe("chatterbox-tts");
  });

  it("finds premium tier TTS rate", () => {
    const rate = lookupRate("tts", "premium");
    expect(rate).toBeDefined();
    expect(rate?.capability).toBe("tts");
    expect(rate?.tier).toBe("premium");
    expect(rate?.provider).toBe("elevenlabs");
  });

  it("returns undefined for non-existent capability", () => {
    const rate = lookupRate("image-generation" as any, "standard");
    expect(rate).toBeUndefined();
  });

  it("returns undefined for non-existent tier", () => {
    const rate = lookupRate("tts", "enterprise" as any);
    expect(rate).toBeUndefined();
  });
});

describe("getRatesForCapability", () => {
  it("returns both standard and premium for TTS", () => {
    const rates = getRatesForCapability("tts");
    expect(rates).toHaveLength(2);
    expect(rates.map((r) => r.tier)).toContain("standard");
    expect(rates.map((r) => r.tier)).toContain("premium");
  });

  it("returns empty array for non-existent capability", () => {
    const rates = getRatesForCapability("image-generation" as any);
    expect(rates).toHaveLength(0);
  });

  it("all returned rates have the requested capability", () => {
    const rates = getRatesForCapability("tts");
    expect(rates.every((r) => r.capability === "tts")).toBe(true);
  });
});

describe("calculateSavings", () => {
  it("calculates savings for TTS at 1M characters", () => {
    const savings = calculateSavings("tts", 1_000_000);

    // Standard: $2.40 per 1M chars
    // Premium: $22.50 per 1M chars
    // Savings: $20.10 per 1M chars
    expect(savings).toBeCloseTo(20.1, 1);
  });

  it("calculates savings for TTS at 100K characters", () => {
    const savings = calculateSavings("tts", 100_000);

    // Standard: $0.24 per 100K chars
    // Premium: $2.25 per 100K chars
    // Savings: $2.01 per 100K chars
    expect(savings).toBeCloseTo(2.01, 2);
  });

  it("returns zero when capability has no standard tier", () => {
    const savings = calculateSavings("image-generation" as any, 1000);
    expect(savings).toBe(0);
  });

  it("returns zero when capability has no premium tier", () => {
    // This would happen if a capability only has self-hosted, no third-party
    const savings = calculateSavings("embeddings" as any, 1000);
    expect(savings).toBe(0);
  });

  it("savings scale linearly with units", () => {
    const savings1M = calculateSavings("tts", 1_000_000);
    const savings2M = calculateSavings("tts", 2_000_000);

    expect(savings2M).toBeCloseTo(savings1M * 2, 1);
  });

  it("savings are always positive or zero", () => {
    // Standard should always be cheaper than premium
    const savings = calculateSavings("tts", 1000);
    expect(savings).toBeGreaterThanOrEqual(0);
  });
});
