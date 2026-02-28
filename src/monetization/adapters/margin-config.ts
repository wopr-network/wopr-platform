/**
 * Model-aware margin multiplier configuration (WOP-364).
 *
 * Expensive models (Opus at $15/$75 per 1M tokens) need lower margins than
 * cheap models (Haiku at $0.80/$4). This module provides rule-based margin
 * lookup so each provider+model combo can have its own multiplier.
 *
 * Production margin values are loaded from the MARGIN_CONFIG_JSON environment
 * variable. See .env.example for the expected shape.
 */

import { getRateOverrideCache } from "../../fleet/services.js";
import type { Credit } from "../credit.js";
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
export function withMarginConfig(cost: Credit, config: MarginConfig, provider: string, model: string): Credit {
  const margin = getMargin(config, provider, model);
  return withMargin(cost, margin);
}

/**
 * Get the effective discount percent for a given adapter from the rate override cache.
 * Returns 0 if no active override exists.
 *
 * Callers can use this to reduce margin for promoted adapters.
 */
export async function getEffectiveDiscountForAdapter(adapterId: string): Promise<number> {
  const cache = getRateOverrideCache();
  return cache.getDiscountPercent(adapterId);
}

/**
 * Load margin configuration from the MARGIN_CONFIG_JSON environment variable.
 * Falls back to a safe 1.3x default if the variable is not set.
 *
 * Set MARGIN_CONFIG_JSON in your environment to override. See .env.example.
 */
export function loadMarginConfig(): MarginConfig {
  const raw = process.env.MARGIN_CONFIG_JSON;
  if (!raw) return { defaultMargin: 1.3, rules: [] };
  try {
    return JSON.parse(raw) as MarginConfig;
  } catch {
    throw new Error("MARGIN_CONFIG_JSON is set but is not valid JSON. Check your environment configuration.");
  }
}
