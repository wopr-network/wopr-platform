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
 * Use with vi.setSystemTime(anchor) for tests needing multiple related timestamps.
 */
export function anchoredTime() {
  const anchor = new Date();
  const offsetDays = (n: number) => new Date(anchor.getTime() + n * 24 * 60 * 60 * 1000);
  const offsetHours = (n: number) => new Date(anchor.getTime() + n * 60 * 60 * 1000);
  return { anchor, offsetDays, offsetHours };
}
