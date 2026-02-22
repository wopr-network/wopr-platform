import type { CircuitBreakerEntry } from "./repository-types.js";

export interface ICircuitBreakerRepository {
  /** Get current state for an instance. Returns null if not seen yet. */
  get(instanceId: string): CircuitBreakerEntry | null;

  /**
   * Increment the request count for the given instance within windowMs.
   * If no entry exists or the window has expired, resets to count = 1.
   * Returns the updated entry.
   */
  incrementOrReset(instanceId: string, windowMs: number): CircuitBreakerEntry;

  /** Mark the circuit as tripped (set trippedAt = now). */
  trip(instanceId: string): void;

  /** Reset the circuit: set count = 0, trippedAt = null, start new window. */
  reset(instanceId: string): void;

  /** Return all entries. */
  getAll(): CircuitBreakerEntry[];

  /** Delete entries whose window started more than windowMs ago and are not tripped. */
  purgeStale(windowMs: number): number;
}
