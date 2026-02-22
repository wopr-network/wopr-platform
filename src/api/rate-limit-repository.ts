import type { RateLimitEntry } from "./repository-types.js";

export interface IRateLimitRepository {
  /**
   * Increment the counter for the given key + scope.
   * If the current window has expired (now - windowStart >= windowMs), resets
   * the counter to 1 and starts a new window.
   * Returns the updated entry.
   */
  increment(key: string, scope: string, windowMs: number): RateLimitEntry;

  /** Read the current entry without modifying it. Returns null if absent. */
  get(key: string, scope: string): RateLimitEntry | null;

  /** Delete entries whose window started more than windowMs ago. */
  purgeStale(windowMs: number): number;
}
