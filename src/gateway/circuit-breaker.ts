/**
 * Per-instance circuit breaker middleware for the API gateway.
 *
 * Tracks request volume per bot instance. When a single instance exceeds
 * maxRequestsPerWindow in windowMs, the circuit "trips":
 * - All subsequent requests from that instance return 429 with a
 *   structured error explaining the pause.
 * - The circuit auto-resets after pauseDurationMs.
 * - The onTrip callback fires once per trip (for notifications/logging).
 *
 * In-memory state is lost on server restart — acceptable for the current
 * single-server architecture.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  /** Max requests per instance in the detection window. Default 100. */
  maxRequestsPerWindow: number;
  /** Detection window in milliseconds. Default 10_000 (10 seconds). */
  windowMs: number;
  /** How long to keep the circuit open (paused) in milliseconds. Default 300_000 (5 minutes). */
  pauseDurationMs: number;
  /** Optional callback when circuit trips — use for notifications/logging. */
  onTrip?: (tenantId: string, instanceId: string, requestCount: number) => void;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxRequestsPerWindow: 100,
  windowMs: 10_000,
  pauseDurationMs: 300_000,
};

interface CircuitState {
  /** Request count in current window */
  count: number;
  /** Window start timestamp */
  windowStart: number;
  /** If tripped: timestamp when the circuit opened (null = closed/healthy) */
  trippedAt: number | null;
}

// ---------------------------------------------------------------------------
// Module-level registry for observability (last created middleware's store)
// ---------------------------------------------------------------------------

let _lastStore: Map<string, CircuitState> = new Map();
let _lastConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG;

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create circuit breaker middleware.
 *
 * Tracks requests per instanceId (falling back to tenantId if instanceId
 * is absent). When a single instance exceeds maxRequestsPerWindow in
 * windowMs, the circuit trips and returns 429 until pauseDurationMs has
 * elapsed.
 */
export function circuitBreaker(config?: Partial<CircuitBreakerConfig>): MiddlewareHandler {
  const cfg: CircuitBreakerConfig = {
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    ...config,
  };

  // Each middleware instance gets its own isolated store
  const store = new Map<string, CircuitState>();

  // Register as the "current" store and config for observability
  _lastStore = store;
  _lastConfig = cfg;

  return async (c: Context, next: Next) => {
    const tenant = c.get("gatewayTenant") as GatewayTenant | undefined;
    const tenantId = tenant?.id ?? "unknown";
    // Fall back to tenantId when instanceId is absent
    const instanceId = tenant?.instanceId ?? tenantId;

    const now = Date.now();
    let state = store.get(instanceId);

    // Initialize fresh state for new instance
    if (!state) {
      state = { count: 0, windowStart: now, trippedAt: null };
      store.set(instanceId, state);
    }

    // Check if circuit is currently tripped
    if (state.trippedAt !== null) {
      const elapsed = now - state.trippedAt;
      if (elapsed >= cfg.pauseDurationMs) {
        // Auto-reset: circuit closes, start fresh window
        state.count = 0;
        state.windowStart = now;
        state.trippedAt = null;
      } else {
        // Still paused — reject request
        const remainingMs = cfg.pauseDurationMs - elapsed;
        const pausedUntilSec = Math.ceil((state.trippedAt + cfg.pauseDurationMs) / 1000);
        c.header("Retry-After", String(Math.ceil(cfg.pauseDurationMs / 1000)));
        return c.json(
          {
            error: {
              message: `Circuit breaker triggered: too many requests from this bot instance. Requests are paused for ${Math.ceil(cfg.pauseDurationMs / 60_000)} minutes to prevent unexpected charges.`,
              type: "rate_limit_error",
              code: "circuit_breaker_tripped",
              paused_until: pausedUntilSec,
              remaining_ms: remainingMs,
            },
          },
          429,
        );
      }
    }

    // Reset window if expired
    if (now - state.windowStart >= cfg.windowMs) {
      state.count = 0;
      state.windowStart = now;
    }

    // Increment count
    state.count++;

    // Check if we've exceeded the threshold → trip the circuit.
    // We allow exactly maxRequestsPerWindow requests per window;
    // the (maxRequestsPerWindow + 1)th request triggers the trip.
    if (state.count > cfg.maxRequestsPerWindow) {
      state.trippedAt = now;

      // Fire onTrip callback exactly once per trip
      cfg.onTrip?.(tenantId, instanceId, state.count);

      // Prune stale entries if store is too large
      if (store.size > 5000) {
        for (const [k, v] of store) {
          if (v.trippedAt === null && now - v.windowStart >= cfg.windowMs) {
            store.delete(k);
          }
        }
      }

      const pausedUntilSec = Math.ceil((now + cfg.pauseDurationMs) / 1000);
      c.header("Retry-After", String(Math.ceil(cfg.pauseDurationMs / 1000)));
      return c.json(
        {
          error: {
            message: `Circuit breaker triggered: too many requests from this bot instance. Requests are paused for ${Math.ceil(cfg.pauseDurationMs / 60_000)} minutes to prevent unexpected charges.`,
            type: "rate_limit_error",
            code: "circuit_breaker_tripped",
            paused_until: pausedUntilSec,
          },
        },
        429,
      );
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * Get the current state of all circuits (from the most recently created
 * circuitBreaker() middleware instance).
 *
 * Returns a Map of instanceId -> { count, trippedAt, remainingPauseMs }.
 */
export function getCircuitStates(): Map<string, { count: number; trippedAt: number | null; remainingPauseMs: number }> {
  const now = Date.now();
  const result = new Map<string, { count: number; trippedAt: number | null; remainingPauseMs: number }>();
  for (const [instanceId, state] of _lastStore) {
    const remainingPauseMs =
      state.trippedAt !== null ? Math.max(0, _lastConfig.pauseDurationMs - (now - state.trippedAt)) : 0;
    result.set(instanceId, {
      count: state.count,
      trippedAt: state.trippedAt,
      remainingPauseMs,
    });
  }
  return result;
}
