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

  // --- Emit ---

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.warn(`[env] WARNING: ${w}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}
