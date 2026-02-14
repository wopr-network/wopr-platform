import { describe, expect, it } from "vitest";
import { formatDate } from "./nightly-backup.js";

describe("formatDate", () => {
  it("formats a date as YYYYMMDD", () => {
    expect(formatDate(new Date("2026-02-14T12:00:00Z"))).toBe("20260214");
  });

  it("zero-pads month and day", () => {
    expect(formatDate(new Date("2026-01-05T00:00:00Z"))).toBe("20260105");
  });

  it("handles December 31", () => {
    expect(formatDate(new Date("2026-12-31T23:59:59Z"))).toBe("20261231");
  });
});
