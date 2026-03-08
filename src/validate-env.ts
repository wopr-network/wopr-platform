import { logger } from "./config/logger.js";

/**
 * Startup environment variable validation.
 *
 * Throws on missing critical vars. Warns on missing recommended vars.
 * Skipped in test environment.
 */
export function validateRequiredEnvVars(): void {
  if (process.env.NODE_ENV === "test") return;

  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Critical (server won't function without these) ---

  const platformSecret = process.env.PLATFORM_SECRET;
  if (!platformSecret) {
    errors.push("PLATFORM_SECRET is required but not set");
  } else if (platformSecret.length < 32) {
    errors.push("PLATFORM_SECRET must be at least 32 characters");
  }

  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is required but not set");
  }

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
  if (!betterAuthSecret) {
    errors.push("BETTER_AUTH_SECRET is required but not set");
  } else if (betterAuthSecret.length < 32) {
    errors.push("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  if (!process.env.BETTER_AUTH_URL) {
    errors.push("BETTER_AUTH_URL is required but not set (default: http://localhost:3100)");
  }

  const platformEncryptionSecret = process.env.PLATFORM_ENCRYPTION_SECRET;
  if (!platformEncryptionSecret) {
    errors.push("PLATFORM_ENCRYPTION_SECRET is required but not set");
  } else if (platformEncryptionSecret.length < 32) {
    errors.push("PLATFORM_ENCRYPTION_SECRET must be at least 32 characters");
  }

  // --- Recommended (billing will break without these) ---

  const creditPriceVars = [
    "STRIPE_CREDIT_PRICE_5",
    "STRIPE_CREDIT_PRICE_10",
    "STRIPE_CREDIT_PRICE_25",
    "STRIPE_CREDIT_PRICE_50",
    "STRIPE_CREDIT_PRICE_100",
  ];
  const missingPrices = creditPriceVars.filter((v) => !process.env[v]);
  if (missingPrices.length > 0) {
    warnings.push(
      `Missing STRIPE_CREDIT_PRICE_* env vars: ${missingPrices.join(", ")}. ` +
        "Credit purchases will fail for unconfigured tiers.",
    );
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    warnings.push("STRIPE_SECRET_KEY is not set — Stripe payments will fail at runtime");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    warnings.push("STRIPE_WEBHOOK_SECRET is not set — Stripe webhook verification will fail");
  }

  // --- Recommended (URLs will fall back to wopr.bot defaults) ---

  if (!process.env.PLATFORM_UI_URL && !process.env.APP_BASE_URL) {
    warnings.push(
      "PLATFORM_UI_URL is not set — falling back to https://app.wopr.bot. " + "Set this for custom domains.",
    );
  }

  if (!process.env.PLATFORM_URL) {
    warnings.push("PLATFORM_URL is not set — falling back to https://api.wopr.bot. " + "Set this for custom domains.");
  }

  if (!process.env.PLATFORM_DOMAIN) {
    warnings.push("PLATFORM_DOMAIN is not set — falling back to wopr.bot. " + "Set this for custom domains.");
  }

  // --- Emit ---

  if (warnings.length > 0) {
    for (const w of warnings) {
      logger.warn(`[env] ${w}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}
