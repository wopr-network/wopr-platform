import type { MiddlewareHandler } from "hono";
import { extractBearerToken } from "../../auth/index.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths exempt from CSRF validation.
 * - /api/auth/* — better-auth handles its own CSRF via trustedOrigins
 * - /api/billing/webhook — Stripe HMAC signature auth
 * - /api/billing/crypto/* — PayRam webhook + checkout
 * - /internal/* — machine-to-machine, static bearer tokens
 * - /health — monitoring probes
 * - /auth/* — email verification redirects (public, GET-only in practice)
 */
function isExempt(path: string): boolean {
  return (
    path.startsWith("/api/auth/") ||
    path === "/api/auth" ||
    path === "/api/billing/webhook" ||
    path.startsWith("/api/billing/crypto/") ||
    path.startsWith("/internal/") ||
    path.startsWith("/health") ||
    path.startsWith("/auth/")
  );
}

/**
 * Validate that a request's Origin or Referer matches one of the allowed origins.
 * Returns true if the request is safe, false if it should be blocked.
 */
export function validateCsrfOrigin(headers: Headers, allowedOrigins: string[]): boolean {
  const origin = headers.get("origin");

  // Check Origin header first (most reliable)
  if (origin) {
    return allowedOrigins.includes(origin);
  }

  // Fall back to Referer header
  const referer = headers.get("referer");
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      return allowedOrigins.includes(refererOrigin);
    } catch {
      return false;
    }
  }

  // No Origin or Referer on a mutation request — block it
  return false;
}

export interface CsrfOptions {
  /** Allowed origins (e.g. ["https://app.wopr.bot"]). */
  allowedOrigins: string[];
}

/**
 * Hono middleware that validates Origin/Referer on state-changing requests.
 * Skips:
 * - GET/HEAD/OPTIONS requests (safe methods)
 * - Requests with Bearer token (not vulnerable to CSRF)
 * - Exempt paths (auth, webhooks, internal, health)
 */
export function csrfProtection(options: CsrfOptions): MiddlewareHandler {
  return async (c, next) => {
    // Safe methods — no CSRF risk
    if (!MUTATION_METHODS.has(c.req.method)) {
      return next();
    }

    // Exempt paths
    if (isExempt(c.req.path)) {
      return next();
    }

    // Bearer-token requests are not vulnerable to CSRF (browser doesn't auto-send)
    const authHeader = c.req.header("Authorization");
    if (extractBearerToken(authHeader)) {
      return next();
    }

    // Only session-authenticated requests need CSRF validation.
    // Unauthenticated requests (no session cookie, no bearer token) should
    // fall through to route-level auth middleware which returns 401.
    // Checking c.get("user") works because resolveSessionUser() runs before
    // this middleware and sets "user" only when a valid session cookie is present.
    let hasSession = false;
    try {
      hasSession = !!c.get("user");
    } catch {
      // c.get throws if variable not set — treat as unauthenticated
    }
    if (!hasSession) {
      return next();
    }

    // Validate Origin/Referer
    if (!validateCsrfOrigin(c.req.raw.headers, options.allowedOrigins)) {
      return c.json({ error: "CSRF validation failed" }, 403);
    }

    return next();
  };
}
