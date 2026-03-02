/** Return a Date N days in the past from now. */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/** Return a Date N days in the future from now. */
export function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

/** Return a Date N hours in the past from now. */
export function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

/** Return a DateRange covering the last N days. */
export function lastNDays(n: number): { from: number; to: number } {
  const now = Date.now();
  return {
    from: now - n * 24 * 60 * 60 * 1000,
    to: now,
  };
}

/**
 * Return a fixed anchor date and helper to offset from it.
 *
 * WARNING: This function calls `new Date()` at invocation time. You MUST call
 * `vi.useFakeTimers()` and `vi.setSystemTime(...)` BEFORE calling this helper,
 * otherwise the anchor will reflect wall-clock time and tests will be non-deterministic.
 *
 * Correct usage:
 *   vi.useFakeTimers();
 *   vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
 *   const { anchor, offsetDays } = anchoredTime(); // anchor = 2026-03-15T12:00:00Z
 */
export function anchoredTime() {
  const anchor = new Date();
  const offsetDays = (n: number) => new Date(anchor.getTime() + n * 24 * 60 * 60 * 1000);
  const offsetHours = (n: number) => new Date(anchor.getTime() + n * 60 * 60 * 1000);
  return { anchor, offsetDays, offsetHours };
}
