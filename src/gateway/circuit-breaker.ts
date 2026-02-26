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
 * State is persisted via ICircuitBreakerRepository (DB-backed in production).
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { ICircuitBreakerRepository } from "./circuit-breaker-repository.js";
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
  /** Repository for persisting circuit state. Required when circuit breaker is active. */
  repo?: ICircuitBreakerRepository;
  /** Optional callback when circuit trips — use for notifications/logging. */
  onTrip?: (tenantId: string, instanceId: string, requestCount: number) => void;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Omit<CircuitBreakerConfig, "repo" | "onTrip"> = {
  maxRequestsPerWindow: 100,
  windowMs: 10_000,
  pauseDurationMs: 300_000,
};

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
export function circuitBreaker(config: CircuitBreakerConfig): MiddlewareHandler {
  const cfg = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };

  return async (c: Context, next: Next) => {
    // No repo — circuit breaker disabled (e.g., test environments)
    if (!cfg.repo) return next();

    const tenant = c.get("gatewayTenant") as GatewayTenant | undefined;
    const tenantId = tenant?.id ?? "unknown";
    // Fall back to tenantId when instanceId is absent
    const instanceId = tenant?.instanceId ?? tenantId;

    const now = Date.now();
    const state = await cfg.repo.get(instanceId);

    // Check if circuit is currently tripped
    if (state?.trippedAt !== null && state?.trippedAt !== undefined) {
      const elapsed = now - state.trippedAt;
      if (elapsed >= cfg.pauseDurationMs) {
        // Auto-reset: circuit closes, start fresh window
        await cfg.repo.reset(instanceId);
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

    // Increment count (resets if window expired)
    const updated = await cfg.repo.incrementOrReset(instanceId, cfg.windowMs);

    // Check if we've exceeded the threshold → trip the circuit.
    // We allow exactly maxRequestsPerWindow requests per window;
    // the (maxRequestsPerWindow + 1)th request triggers the trip.
    if (updated.count > cfg.maxRequestsPerWindow) {
      await cfg.repo.trip(instanceId);

      // Fire onTrip callback exactly once per trip
      cfg.onTrip?.(tenantId, instanceId, updated.count);

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
 * Get the current state of all circuits from the repository.
 *
 * Returns a Map of instanceId -> { count, trippedAt, remainingPauseMs }.
 */
export async function getCircuitStates(
  repo: ICircuitBreakerRepository,
  pauseDurationMs = DEFAULT_CIRCUIT_BREAKER_CONFIG.pauseDurationMs,
): Promise<Map<string, { count: number; trippedAt: number | null; remainingPauseMs: number }>> {
  const now = Date.now();
  const result = new Map<string, { count: number; trippedAt: number | null; remainingPauseMs: number }>();
  for (const entry of await repo.getAll()) {
    const remainingPauseMs = entry.trippedAt !== null ? Math.max(0, pauseDurationMs - (now - entry.trippedAt)) : 0;
    result.set(entry.instanceId, {
      count: entry.count,
      trippedAt: entry.trippedAt,
      remainingPauseMs,
    });
  }
  return result;
}
