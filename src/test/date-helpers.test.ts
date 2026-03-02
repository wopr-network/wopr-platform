import { describe, expect, it } from "vitest";
import { anchoredTime, daysAgo, daysFromNow, hoursAgo, lastNDays } from "./date-helpers.js";

describe("date-helpers", () => {
  it("daysAgo returns a date in the past", () => {
    const result = daysAgo(7);
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it("daysFromNow returns a date in the future", () => {
    const result = daysFromNow(7);
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it("hoursAgo returns a date in the past", () => {
    const result = hoursAgo(2);
    const expected = Date.now() - 2 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it("lastNDays returns a range", () => {
    const range = lastNDays(30);
    expect(range.to).toBeGreaterThan(range.from);
    expect(range.to - range.from).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -3);
  });

  it("anchoredTime produces consistent offsets", () => {
    const { anchor, offsetDays, offsetHours } = anchoredTime();
    expect(offsetDays(1).getTime() - anchor.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(offsetHours(-2).getTime() - anchor.getTime()).toBe(-2 * 60 * 60 * 1000);
  });
});
