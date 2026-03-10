import { csrfProtection as baseCsrfProtection, validateCsrfOrigin } from "@wopr-network/platform-core/middleware";

export { validateCsrfOrigin };

/**
 * WOPR-specific exempt paths.
 * - /api/auth/* — better-auth handles its own CSRF via trustedOrigins
 * - /api/billing/webhook — Stripe HMAC signature auth
 * - /api/billing/crypto/* — PayRam webhook + checkout
 * - /internal/* — machine-to-machine, static bearer tokens
 * - /health — monitoring probes
 * - /auth/* — email verification redirects (public, GET-only in practice)
 */
const WOPR_EXEMPT_PATHS = [
  "/api/auth",
  "/api/auth/*",
  "/api/billing/webhook",
  "/api/billing/crypto/*",
  "/internal/*",
  "/health*",
  "/auth/*",
];

export interface CsrfOptions {
  allowedOrigins: string[];
}

/** CSRF protection with WOPR-specific exempt paths baked in. */
export function csrfProtection(options: CsrfOptions) {
  return baseCsrfProtection({
    allowedOrigins: options.allowedOrigins,
    exemptPaths: WOPR_EXEMPT_PATHS,
  });
}
