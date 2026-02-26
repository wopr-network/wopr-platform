import type { CircuitBreakerEntry } from "./repository-types.js";

export interface ICircuitBreakerRepository {
  /** Get current state for an instance. Returns null if not seen yet. */
  get(instanceId: string): Promise<CircuitBreakerEntry | null>;

  /**
   * Increment the request count for the given instance within windowMs.
   * If no entry exists or the window has expired, resets to count = 1.
   * Returns the updated entry.
   */
  incrementOrReset(instanceId: string, windowMs: number): Promise<CircuitBreakerEntry>;

  /** Mark the circuit as tripped (set trippedAt = now). */
  trip(instanceId: string): Promise<void>;

  /** Reset the circuit: set count = 0, trippedAt = null, start new window. */
  reset(instanceId: string): Promise<void>;

  /** Return all entries. */
  getAll(): Promise<CircuitBreakerEntry[]>;

  /** Delete entries whose window started more than windowMs ago and are not tripped. */
  purgeStale(windowMs: number): Promise<number>;
}
