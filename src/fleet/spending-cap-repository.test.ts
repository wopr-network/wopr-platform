import { describe, expect, it } from "vitest";
import { getDayStart, getMonthStart } from "./spending-cap-repository.js";

describe("getDayStart", () => {
  it("returns midnight UTC for the given timestamp", () => {
    // 2024-03-15T14:30:00Z
    const ts = Date.UTC(2024, 2, 15, 14, 30, 0);
    const result = getDayStart(ts);
    expect(result).toBe(Date.UTC(2024, 2, 15, 0, 0, 0, 0));
  });
});

describe("getMonthStart", () => {
  it("returns the first of the month at midnight UTC", () => {
    // 2024-03-15T14:30:00Z
    const ts = Date.UTC(2024, 2, 15, 14, 30, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2024, 2, 1, 0, 0, 0, 0));
  });

  it("uses UTC month, not local month (boundary test)", () => {
    // 2024-04-01T00:30:00Z — in UTC-5 this would still be March 31
    // The function receives a UTC timestamp, so it must return April 1 UTC.
    const ts = Date.UTC(2024, 3, 1, 0, 30, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2024, 3, 1, 0, 0, 0, 0));
  });

  it("handles December correctly", () => {
    const ts = Date.UTC(2024, 11, 25, 10, 0, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2024, 11, 1, 0, 0, 0, 0));
  });

  it("handles January correctly", () => {
    const ts = Date.UTC(2025, 0, 15, 10, 0, 0);
    const result = getMonthStart(ts);
    expect(result).toBe(Date.UTC(2025, 0, 1, 0, 0, 0, 0));
  });
});
