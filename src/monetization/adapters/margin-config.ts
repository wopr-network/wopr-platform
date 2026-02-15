/**
 * Model-aware margin multiplier configuration (WOP-364).
 *
 * Expensive models (Opus at $15/$75 per 1M tokens) need lower margins than
 * cheap models (Haiku at $0.80/$4). This module provides rule-based margin
 * lookup so each provider+model combo can have its own multiplier.
 */

import { withMargin } from "./types.js";

/** A single margin rule: provider + model pattern -> margin multiplier */
export interface MarginRule {
  /** Provider name (e.g., "openrouter", "gemini", "elevenlabs") */
  provider: string;
  /** Model pattern -- glob or exact match (e.g., "anthropic/claude-opus-*", "*") */
  modelPattern: string;
  /**
   * Margin multiplier for this provider+model combo.
   * This is a multiplier, NOT a percentage: 1.3 = 30% margin, 1.5 = 50% margin.
   * Values in the range [3, 100] would be interpreted as multipliers (e.g., 3 = 200% markup),
   * which is almost certainly a mistake. Typical values: 1.1 to 2.0.
   */
  margin: number;
}

/** Top-level margin configuration */
export interface MarginConfig {
  /** Default margin if no rule matches */
  defaultMargin: number;
  /** Rules checked in order -- first match wins */
  rules: MarginRule[];
}

/**
 * Check whether a model name matches a glob pattern.
 *
 * Supports `*` as a wildcard that matches any sequence of characters.
 * Each `*` in the pattern is converted to `.*` in a regex; all other
 * characters are escaped for literal matching.
 */
function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;

  // Convert glob pattern to regex: escape regex-special chars, then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Look up margin for a given provider + model.
 * Checks rules in order, returns first match. Falls back to defaultMargin.
 */
export function getMargin(config: MarginConfig, provider: string, model: string): number {
  for (const rule of config.rules) {
    if (rule.provider === provider && matchesPattern(rule.modelPattern, model)) {
      return rule.margin;
    }
  }
  return config.defaultMargin;
}

/**
 * Apply a model-aware margin to a wholesale cost.
 *
 * Looks up the correct margin for the given provider+model, then delegates
 * to the existing `withMargin()` function for the actual calculation.
 */
export function withMarginConfig(cost: number, config: MarginConfig, provider: string, model: string): number {
  const margin = getMargin(config, provider, model);
  return withMargin(cost, margin);
}

/** Default margin rules -- can be overridden per-deployment via env/config */
export const DEFAULT_MARGIN_CONFIG: MarginConfig = {
  defaultMargin: 1.3,
  rules: [
    // Self-hosted adapters — low margin because we own the hardware
    // These come first so they match before third-party rules
    { provider: "chatterbox-tts", modelPattern: "*", margin: 1.2 },
    { provider: "self-hosted-llm", modelPattern: "*", margin: 1.15 },
    { provider: "self-hosted-whisper", modelPattern: "*", margin: 1.2 },
    { provider: "self-hosted-embeddings", modelPattern: "*", margin: 1.15 },
    // Expensive models -- lower margin (still profitable at volume)
    { provider: "openrouter", modelPattern: "anthropic/claude-opus-*", margin: 1.15 },
    { provider: "openrouter", modelPattern: "anthropic/claude-sonnet-*", margin: 1.2 },
    { provider: "gemini", modelPattern: "gemini-2.5-pro*", margin: 1.2 },
    // Cheap models -- higher margin
    { provider: "openrouter", modelPattern: "anthropic/claude-haiku-*", margin: 1.5 },
    { provider: "openrouter", modelPattern: "openai/gpt-4o-mini*", margin: 1.5 },
    { provider: "gemini", modelPattern: "gemini-2.0-flash*", margin: 1.4 },
    // Voice -- high perceived value
    { provider: "elevenlabs", modelPattern: "*", margin: 1.5 },
    { provider: "deepgram", modelPattern: "*", margin: 1.4 },
  ],
};
