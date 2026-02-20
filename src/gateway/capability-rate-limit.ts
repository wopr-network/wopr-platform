/**
 * Per-capability rate limiting middleware for the API gateway.
 *
 * Applies different rate limits based on the capability being requested
 * (determined by route path). Each capability category gets its own
 * independent fixed-window counter per tenant.
 *
 * In-memory state is lost on server restart — acceptable for the current
 * single-server architecture.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
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

interface WindowEntry {
  count: number;
  windowStart: number;
}

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
 * Keys by tenant ID within each capability-specific store so each org
 * gets independent limits per capability. Returns 429 with Retry-After
 * header when exceeded.
 */
export function capabilityRateLimit(config?: Partial<CapabilityRateLimitConfig>): MiddlewareHandler {
  const limits: CapabilityRateLimitConfig = {
    ...DEFAULT_CAPABILITY_LIMITS,
    ...config,
  };

  // One store per capability category
  const stores: Record<keyof CapabilityRateLimitConfig, Map<string, WindowEntry>> = {
    llm: new Map(),
    imageGen: new Map(),
    audioSpeech: new Map(),
    telephony: new Map(),
  };

  return async (c: Context, next: Next) => {
    const path = c.req.path;
    const category = resolveCapabilityCategory(path);

    // Unknown path — no rate limit applied
    if (category === null) {
      return next();
    }

    const tenant = c.get("gatewayTenant") as GatewayTenant | undefined;
    const tenantId = tenant?.id ?? "unknown";
    const max = limits[category];
    const store = stores[category];
    const now = Date.now();

    let entry = store.get(tenantId);
    if (!entry || now - entry.windowStart >= DEFAULT_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      store.set(tenantId, entry);
    }

    // Prune stale entries to bound memory growth
    if (store.size > 1000) {
      for (const [k, v] of store) {
        if (now - v.windowStart >= DEFAULT_WINDOW_MS) store.delete(k);
      }
    }

    const resetAt = Math.ceil((entry.windowStart + DEFAULT_WINDOW_MS) / 1000);
    const retryAfterSec = Math.ceil((entry.windowStart + DEFAULT_WINDOW_MS - now) / 1000);

    if (entry.count >= max) {
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

    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetAt));

    return next();
  };
}
