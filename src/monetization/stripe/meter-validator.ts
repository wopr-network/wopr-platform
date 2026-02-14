import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
import type { MeterEventNameMap } from "../metering/usage-aggregation-worker.js";

/** Validation modes for Stripe Meter configuration. */
export type ValidationMode = "strict" | "warn";

/** Critical capabilities that must have Stripe Meters in strict mode. */
const CRITICAL_CAPABILITIES = new Set(["chat", "stt"]);

/** Configuration options for Stripe Meter validation. */
export interface MeterValidatorOpts {
  /**
   * Validation mode:
   * - "strict": Fail validation (throw error) if critical meters are missing
   * - "warn": Log warnings but continue (default)
   */
  mode?: ValidationMode;
  /** Custom set of critical capabilities for strict mode validation. */
  criticalCapabilities?: Set<string>;
}

/** Result of Stripe Meter validation. */
export interface ValidationResult {
  /** Whether validation passed (all configured meters exist in Stripe). */
  valid: boolean;
  /** Capabilities configured locally but missing in Stripe. */
  missing: string[];
  /** Capabilities with matching Stripe Meters. */
  found: string[];
  /** Critical capabilities that are missing (causes failure in strict mode). */
  criticalMissing: string[];
}

/**
 * Validates that configured Stripe Meters exist in the Stripe dashboard.
 *
 * This prevents silent billing failures by checking at startup that the
 * meter event names we're sending to Stripe actually correspond to
 * Meter objects configured in the Stripe dashboard.
 *
 * Design:
 * - Lists all Stripe Meters via stripe.billing.meters.list()
 * - Compares against the configured MeterEventNameMap
 * - In "warn" mode (default): logs warnings for missing meters
 * - In "strict" mode: throws error if critical meters are missing
 *
 * @param stripe Stripe client instance
 * @param meterEventNames Mapping of capability -> Stripe meter event_name
 * @param opts Validation options (mode, critical capabilities)
 * @returns Validation result with missing/found capabilities
 * @throws Error in strict mode if critical meters are missing
 */
export async function validateStripeMeters(
  stripe: Stripe,
  meterEventNames: MeterEventNameMap,
  opts: MeterValidatorOpts = {},
): Promise<ValidationResult> {
  const mode = opts.mode ?? "warn";
  const criticalCapabilities = opts.criticalCapabilities ?? CRITICAL_CAPABILITIES;

  logger.info("Validating Stripe Meter configuration", {
    mode,
    configuredCapabilities: Object.keys(meterEventNames).length,
  });

  // Fetch all Stripe Meters from the dashboard
  let stripeMeters: Stripe.Billing.Meter[];
  try {
    const response = await stripe.billing.meters.list({ limit: 100 });
    stripeMeters = response.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to list Stripe Meters", { error: message });
    throw new Error(`Failed to list Stripe Meters: ${message}`);
  }

  // Build a set of Stripe Meter event names for O(1) lookup
  const stripeMeterNames = new Set(stripeMeters.map((m) => m.event_name));

  // Check each configured capability against Stripe
  const found: string[] = [];
  const missing: string[] = [];
  const criticalMissing: string[] = [];

  for (const [capability, eventName] of Object.entries(meterEventNames)) {
    if (stripeMeterNames.has(eventName)) {
      found.push(capability);
      logger.debug("Stripe Meter found", { capability, eventName });
    } else {
      missing.push(capability);
      const isCritical = criticalCapabilities.has(capability);

      if (isCritical) {
        criticalMissing.push(capability);
        logger.error("CRITICAL: Stripe Meter missing", { capability, eventName });
      } else {
        logger.warn("Stripe Meter missing", { capability, eventName });
      }
    }
  }

  // Log summary
  if (missing.length > 0) {
    logger.warn("Stripe Meter validation incomplete", {
      missing: missing.length,
      found: found.length,
      criticalMissing: criticalMissing.length,
    });
  } else {
    logger.info("Stripe Meter validation passed", { found: found.length });
  }

  const result: ValidationResult = {
    valid: missing.length === 0,
    missing,
    found,
    criticalMissing,
  };

  // In strict mode, fail startup if critical meters are missing
  if (mode === "strict" && criticalMissing.length > 0) {
    const details = criticalMissing.map((c) => `${c} -> ${meterEventNames[c]}`).join(", ");
    throw new Error(
      `Stripe Meter validation failed in strict mode. Missing critical meters: ${details}. ` +
        `Configure these meters in your Stripe dashboard before starting the platform.`,
    );
  }

  return result;
}
