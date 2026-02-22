/**
 * Per-capability rate limiting middleware for the API gateway.
 *
 * Applies different rate limits based on the capability being requested
 * (determined by route path). Each capability category gets its own
 * independent fixed-window counter per tenant.
 *
 * State is persisted via IRateLimitRepository (DB-backed in production).
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { IRateLimitRepository } from "../api/rate-limit-repository.js";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityRateLimitConfig {
  /** LLM endpoints (chat/completions, completions, embeddings): max req/min. Default 60. */
  llm: number;
  /** Image/video generation: max req/min. Default 10. */
  imageGen: number;
  /** TTS/STT: max req/min. Default 30. */
  audioSpeech: number;
  /** Phone/SMS: max req/min. Default 100. */
  telephony: number;
}

export const DEFAULT_CAPABILITY_LIMITS: CapabilityRateLimitConfig = {
  llm: 60,
  imageGen: 10,
  audioSpeech: 30,
  telephony: 100,
};

const DEFAULT_WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Path → capability category resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which capability category a request path belongs to.
 * Returns the category key from CapabilityRateLimitConfig, or null if
 * the path does not match any known capability (no rate limit applied).
 */
export function resolveCapabilityCategory(path: string): keyof CapabilityRateLimitConfig | null {
  if (path.startsWith("/chat/completions") || path.startsWith("/completions") || path.startsWith("/embeddings")) {
    return "llm";
  }
  if (path.startsWith("/images/generations") || path.startsWith("/video/generations")) {
    return "imageGen";
  }
  if (path.startsWith("/audio/transcriptions") || path.startsWith("/audio/speech")) {
    return "audioSpeech";
  }
  if (path.startsWith("/phone/") || path.startsWith("/messages/")) {
    return "telephony";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create per-capability rate limiting middleware.
 *
 * Keys by tenant ID within each capability-specific scope so each org
 * gets independent limits per capability. Returns 429 with Retry-After
 * header when exceeded.
 */
export function capabilityRateLimit(
  config: Partial<CapabilityRateLimitConfig> | undefined,
  repo: IRateLimitRepository | undefined,
): MiddlewareHandler {
  const limits: CapabilityRateLimitConfig = {
    ...DEFAULT_CAPABILITY_LIMITS,
    ...config,
  };

  return async (c: Context, next: Next) => {
    // No repo — rate limiting disabled (e.g., test environments)
    if (!repo) return next();

    const path = c.req.path;
    const category = resolveCapabilityCategory(path);

    // Unknown path — no rate limit applied
    if (category === null) {
      return next();
    }

    const tenant = c.get("gatewayTenant") as GatewayTenant | undefined;
    const tenantId = tenant?.id ?? "unknown";
    const max = limits[category];
    const scope = `cap:${category}`;
    const now = Date.now();

    const entry = repo.increment(tenantId, scope, DEFAULT_WINDOW_MS);
    const windowStart = entry.windowStart;
    const count = entry.count;

    const resetAt = Math.ceil((windowStart + DEFAULT_WINDOW_MS) / 1000);
    const retryAfterSec = Math.ceil((windowStart + DEFAULT_WINDOW_MS - now) / 1000);

    if (count > max) {
      c.header("X-RateLimit-Limit", String(max));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(resetAt));
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: {
            message: `Rate limit exceeded for ${category} capability. Please slow down.`,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        },
        429,
      );
    }

    const remaining = Math.max(0, max - count);
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetAt));

    return next();
  };
}
