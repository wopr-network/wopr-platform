/**
 * Two-tier pricing rate table.
 *
 * Maps (capability, tier) → cost parameters. This is the central reference for:
 * - Pricing comparisons (standard vs premium)
 * - Admin dashboard pricing display
 * - Metering layer cost validation
 * - Adapter routing decisions
 *
 * Standard tier = self-hosted, lower cost
 * Premium tier = third-party brand-name APIs, higher cost
 */

import type { AdapterCapability } from "./types.js";

export interface RateEntry {
  /** Which capability this rate applies to */
  capability: AdapterCapability;
  /** Pricing tier: standard (self-hosted) or premium (third-party) */
  tier: "standard" | "premium";
  /** Provider name (e.g., "chatterbox-tts", "elevenlabs") */
  provider: string;
  /** Cost per unit (character, token, minute, image, etc.) in USD */
  costPerUnit: number;
  /** What the unit is (e.g., "per-character", "per-token", "per-minute") */
  billingUnit: string;
  /** Margin multiplier */
  margin: number;
  /** Effective user-facing price per unit (costPerUnit * margin) */
  effectivePrice: number;
}

/**
 * The rate table.
 *
 * Each capability has both standard and premium entries. Standard is always
 * cheaper than premium for the same capability (that's the whole point).
 *
 * Entries are added as self-hosted adapters are implemented. Currently only
 * TTS (Chatterbox vs ElevenLabs) is in the table.
 */
export const RATE_TABLE: RateEntry[] = [
  // TTS - Text-to-Speech
  {
    capability: "tts",
    tier: "standard",
    provider: "chatterbox-tts",
    costPerUnit: 0.000002, // Amortized GPU cost
    billingUnit: "per-character",
    margin: 1.2, // 20% margin
    effectivePrice: 0.0000024, // $2.40 per 1M chars
  },
  {
    capability: "tts",
    tier: "premium",
    provider: "elevenlabs",
    costPerUnit: 0.000015, // Third-party wholesale
    billingUnit: "per-character",
    margin: 1.5, // 50% margin
    effectivePrice: 0.0000225, // $22.50 per 1M chars
  },

  // Future self-hosted adapters will add more entries here:
  // - transcription: self-hosted-whisper (standard) vs deepgram (premium)
  // - text-generation: self-hosted-llm (standard) vs openrouter (premium)
  // - embeddings: self-hosted-embeddings (standard) vs openrouter (premium)
  // - image-generation: self-hosted-sdxl (standard) vs replicate (premium)
];

/**
 * Look up a rate entry by capability and tier.
 *
 * @param capability - The capability to look up
 * @param tier - The pricing tier ("standard" or "premium")
 * @returns The rate entry, or undefined if not found
 */
export function lookupRate(capability: AdapterCapability, tier: "standard" | "premium"): RateEntry | undefined {
  return RATE_TABLE.find((entry) => entry.capability === capability && entry.tier === tier);
}

/**
 * Get all rate entries for a given capability.
 *
 * @param capability - The capability to look up
 * @returns Array of rate entries (both standard and premium if available)
 */
export function getRatesForCapability(capability: AdapterCapability): RateEntry[] {
  return RATE_TABLE.filter((entry) => entry.capability === capability);
}

/**
 * Calculate cost savings from using standard tier vs premium.
 *
 * @param capability - The capability to compare
 * @param units - Number of units (characters, tokens, etc.)
 * @returns Savings in USD, or 0 if either tier is unavailable
 */
export function calculateSavings(capability: AdapterCapability, units: number): number {
  const standard = lookupRate(capability, "standard");
  const premium = lookupRate(capability, "premium");

  if (!standard || !premium) return 0;

  const standardCost = standard.effectivePrice * units;
  const premiumCost = premium.effectivePrice * units;

  return Math.max(0, premiumCost - standardCost);
}
