/**
 * Rate-limiting middleware for Hono.
 *
 * Uses a fixed-window counter keyed by client IP. Each window is `windowMs`
 * milliseconds wide. When a client exceeds `max` requests in a window the
 * middleware responds with 429 Too Many Requests and a `Retry-After` header
 * indicating how many seconds remain in the current window.
 *
 * Stale entries are lazily pruned on every request to bound memory growth.
 */

import type { Context, MiddlewareHandler, Next } from "hono";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum number of requests per window. */
  max: number;
  /** Window size in milliseconds (default: 60 000 = 1 minute). */
  windowMs?: number;
  /** Extract the rate-limit key from a request (default: client IP). */
  keyGenerator?: (c: Context) => string;
  /** Custom message returned in the 429 body (default provided). */
  message?: string;
}

interface WindowEntry {
  count: number;
  /** Timestamp (ms) when the current window started. */
  windowStart: number;
}

export interface RateLimitRule {
  /** HTTP method to match, or "*" for any. */
  method: string;
  /** Path prefix to match (matched with `startsWith`). */
  pathPrefix: string;
  /** Rate-limit configuration for matching requests. */
  config: RateLimitConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default key generator: uses the first value of `X-Forwarded-For`, falling
 * back to the remote address reported by the runtime, then "unknown".
 *
 * NOTE: `X-Forwarded-For` can be spoofed by clients. In production, deploy
 * behind a reverse proxy (e.g. nginx, Cloudflare) that overwrites this header
 * with the real client IP, or supply a custom `keyGenerator` that validates
 * the header against a list of trusted proxy addresses.
 */
function defaultKeyGenerator(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // Hono on @hono/node-server exposes env.incoming with the socket
  const incoming = (c.env as Record<string, unknown>)?.incoming as { socket?: { remoteAddress?: string } } | undefined;
  if (incoming?.socket?.remoteAddress) return incoming.socket.remoteAddress;
  return "unknown";
}

const DEFAULT_WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Single-route rate limiter
// ---------------------------------------------------------------------------

/**
 * Create a rate-limiting middleware for a single configuration.
 *
 * ```ts
 * app.use("/api/billing/*", rateLimit({ max: 10 }));
 * ```
 */
export function rateLimit(cfg: RateLimitConfig): MiddlewareHandler {
  const windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
  const keyGen = cfg.keyGenerator ?? defaultKeyGenerator;
  const store = new Map<string, WindowEntry>();

  return async (c: Context, next: Next) => {
    const now = Date.now();
    const key = keyGen(c);

    let entry = store.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      // New window
      entry = { count: 0, windowStart: now };
      store.set(key, entry);
    }

    // Prune stale keys every time (cheap for typical request volumes)
    if (store.size > 1000) {
      for (const [k, v] of store) {
        if (now - v.windowStart >= windowMs) store.delete(k);
      }
    }

    // Check limit BEFORE incrementing so that `max` requests are allowed, not `max + 1`
    const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);

    if (entry.count >= cfg.max) {
      c.header("X-RateLimit-Limit", String(cfg.max));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil((entry.windowStart + windowMs) / 1000)));
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: cfg.message ?? "Too many requests, please try again later" }, 429);
    }

    entry.count++;

    // Set rate-limit headers (draft standard)
    const remaining = Math.max(0, cfg.max - entry.count);

    c.header("X-RateLimit-Limit", String(cfg.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil((entry.windowStart + windowMs) / 1000)));

    return next();
  };
}

// ---------------------------------------------------------------------------
// Multi-route rate limiter (global middleware with per-route overrides)
// ---------------------------------------------------------------------------

/**
 * Create a global rate-limiting middleware that applies different limits based
 * on the request path and method.
 *
 * Rules are evaluated top-to-bottom; the **first** matching rule wins. If no
 * rule matches, the `defaultConfig` is used.
 *
 * ```ts
 * app.use("*", rateLimitByRoute(rules, { max: 60 }));
 * ```
 */
export function rateLimitByRoute(rules: RateLimitRule[], defaultConfig: RateLimitConfig): MiddlewareHandler {
  // Each rule gets its own independent store keyed by index so that two rules
  // sharing the same config object (e.g. billing checkout & portal both using
  // BILLING_LIMIT) still maintain separate counters.
  const stores: Map<string, WindowEntry>[] = rules.map(() => new Map());
  const defaultStore = new Map<string, WindowEntry>();

  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    const path = c.req.path;

    // Find matching rule
    let cfg = defaultConfig;
    let store = defaultStore;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const methodMatch = rule.method === "*" || rule.method.toUpperCase() === method;
      if (methodMatch && path.startsWith(rule.pathPrefix)) {
        cfg = rule.config;
        store = stores[i];
        break;
      }
    }

    const windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    const keyGen = cfg.keyGenerator ?? defaultKeyGenerator;
    const now = Date.now();
    const key = keyGen(c);

    let entry = store.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      store.set(key, entry);
    }

    if (store.size > 1000) {
      for (const [k, v] of store) {
        if (now - v.windowStart >= windowMs) store.delete(k);
      }
    }

    // Check limit BEFORE incrementing so that `max` requests are allowed, not `max + 1`
    const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);

    if (entry.count >= cfg.max) {
      c.header("X-RateLimit-Limit", String(cfg.max));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil((entry.windowStart + windowMs) / 1000)));
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: cfg.message ?? "Too many requests, please try again later" }, 429);
    }

    entry.count++;

    const remaining = Math.max(0, cfg.max - entry.count);

    c.header("X-RateLimit-Limit", String(cfg.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil((entry.windowStart + windowMs) / 1000)));

    return next();
  };
}

// ---------------------------------------------------------------------------
// Pre-built route rules matching the WOP-323 specification
// ---------------------------------------------------------------------------

/** Webhook: 30 req/min (WOP-477) */
const WEBHOOK_LIMIT: RateLimitConfig = { max: 30 };

/** Billing checkout/portal: 10 req/min */
const BILLING_LIMIT: RateLimitConfig = { max: 10 };

/** Secrets validation: 5 req/min */
const SECRETS_VALIDATION_LIMIT: RateLimitConfig = { max: 5 };

/** Fleet create (POST /fleet/bots): 30 req/min */
const FLEET_CREATE_LIMIT: RateLimitConfig = { max: 30 };

/** Fleet read operations (GET /fleet/*): 120 req/min */
const FLEET_READ_LIMIT: RateLimitConfig = { max: 120 };

/** Default for everything else: 60 req/min */
const DEFAULT_LIMIT: RateLimitConfig = { max: 60 };

/** Auth login: 5 failed attempts per 15 minutes (WOP-839) */
const AUTH_LOGIN_LIMIT: RateLimitConfig = {
  max: 5,
  windowMs: 15 * 60 * 1000, // 15 minutes
  message: "Too many login attempts. Please try again in 15 minutes.",
};

/** Auth signup: 10 per hour per IP (WOP-839) */
const AUTH_SIGNUP_LIMIT: RateLimitConfig = {
  max: 10,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: "Too many sign-up attempts. Please try again later.",
};

/** Auth password reset: 3 per hour per IP (WOP-839) */
const AUTH_RESET_LIMIT: RateLimitConfig = {
  max: 3,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: "Too many password reset requests. Please try again later.",
};

/**
 * Pre-configured route rules for the WOPR platform. Evaluated top-to-bottom;
 * first match wins.
 */
export const platformRateLimitRules: RateLimitRule[] = [
  // Auth: brute force prevention — 5 req/15min for login (WOP-839)
  { method: "POST", pathPrefix: "/api/auth/sign-in", config: AUTH_LOGIN_LIMIT },

  // Auth: signup abuse prevention — 10 req/hr per IP (WOP-839)
  { method: "POST", pathPrefix: "/api/auth/sign-up", config: AUTH_SIGNUP_LIMIT },

  // Auth: password reset abuse prevention — 3 req/hr per IP (WOP-839)
  { method: "POST", pathPrefix: "/api/auth/request-password-reset", config: AUTH_RESET_LIMIT },

  // Secrets validation — most restrictive, check first
  { method: "POST", pathPrefix: "/api/validate-key", config: SECRETS_VALIDATION_LIMIT },

  // Webhook: 30 req/min (WOP-477)
  { method: "POST", pathPrefix: "/api/billing/webhook", config: WEBHOOK_LIMIT },

  // Billing checkout & portal
  { method: "POST", pathPrefix: "/api/billing/checkout", config: BILLING_LIMIT },
  { method: "POST", pathPrefix: "/api/billing/portal", config: BILLING_LIMIT },

  // Fleet create
  { method: "POST", pathPrefix: "/fleet/bots", config: FLEET_CREATE_LIMIT },

  // Fleet read operations (GET)
  { method: "GET", pathPrefix: "/fleet/", config: FLEET_READ_LIMIT },
];

export const platformDefaultLimit = DEFAULT_LIMIT;
