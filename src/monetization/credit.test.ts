import { describe, expect, it } from "vitest";
import { Credit } from "./credit.js";

describe("Credit", () => {
  describe("factory methods", () => {
    it("fromDollars creates correct raw value", () => {
      const c = Credit.fromDollars(1);
      expect(c.toRaw()).toBe(1_000_000_000);
    });

    it("fromDollars handles sub-cent precision", () => {
      const c = Credit.fromDollars(0.001); // 1 mill
      expect(c.toRaw()).toBe(1_000_000);
    });

    it("fromCents creates correct raw value", () => {
      const c = Credit.fromCents(1);
      expect(c.toRaw()).toBe(10_000_000);
    });

    it("fromCents handles fractional cents", () => {
      const c = Credit.fromCents(0.5);
      expect(c.toRaw()).toBe(5_000_000);
    });

    it("fromRaw stores exact value", () => {
      const c = Credit.fromRaw(42);
      expect(c.toRaw()).toBe(42);
    });

    it("fromRaw rejects non-integer", () => {
      expect(() => Credit.fromRaw(1.5)).toThrow(TypeError);
    });

    it("zero creates zero credit", () => {
      expect(Credit.zero().toRaw()).toBe(0);
    });

    it("ZERO has raw value 0", () => {
      expect(Credit.ZERO.toRaw()).toBe(0);
    });
  });

  describe("conversion", () => {
    it("toDollars converts correctly", () => {
      const c = Credit.fromRaw(1_000_000_000);
      expect(c.toDollars()).toBe(1);
    });

    it("toCents converts correctly", () => {
      const c = Credit.fromRaw(10_000_000);
      expect(c.toCents()).toBe(1);
    });

    it("sub-cent value round-trips through fromCents/toCents", () => {
      const c = Credit.fromCents(0.123);
      // 0.123 cents * 10_000_000 raw-per-cent = 1_230_000
      expect(c.toRaw()).toBe(1_230_000);
      expect(c.toCents()).toBeCloseTo(0.123, 10);
    });

    it("toDisplayString formats as currency", () => {
      expect(Credit.fromDollars(1.5).toDisplayString()).toBe("$1.50");
    });

    it("toDisplayString rounds sub-cent to two decimals", () => {
      // 1 raw unit = $0.000000001, should display as $0.00
      expect(Credit.fromRaw(1).toDisplayString()).toBe("$0.00");
      // $0.999 should display as $1.00
      expect(Credit.fromRaw(999_000_000).toDisplayString()).toBe("$1.00");
    });
  });

  describe("arithmetic", () => {
    it("add combines two credits", () => {
      const a = Credit.fromCents(10);
      const b = Credit.fromCents(20);
      expect(a.add(b).toRaw()).toBe(300_000_000);
    });

    it("subtract removes credits", () => {
      const a = Credit.fromCents(30);
      const b = Credit.fromCents(10);
      expect(a.subtract(b).toRaw()).toBe(200_000_000);
    });

    it("subtract can produce negative", () => {
      const a = Credit.fromCents(5);
      const b = Credit.fromCents(10);
      expect(a.subtract(b).isNegative()).toBe(true);
    });

    it("multiply scales by factor", () => {
      const c = Credit.fromDollars(1);
      expect(c.multiply(2.5).toRaw()).toBe(2_500_000_000);
    });

    it("multiply rounds to integer raw", () => {
      const c = Credit.fromRaw(3);
      // 3 * 0.5 = 1.5, rounds to 2
      expect(c.multiply(0.5).toRaw()).toBe(2);
    });

    it("multiply by zero gives zero", () => {
      expect(Credit.fromDollars(5).multiply(0).isZero()).toBe(true);
    });
  });

  describe("comparison", () => {
    it("isNegative returns true for negative", () => {
      expect(Credit.fromRaw(-1).isNegative()).toBe(true);
    });

    it("isNegative returns false for zero", () => {
      expect(Credit.zero().isNegative()).toBe(false);
    });

    it("isZero returns true for zero", () => {
      expect(Credit.zero().isZero()).toBe(true);
    });

    it("isZero returns false for non-zero", () => {
      expect(Credit.fromRaw(1).isZero()).toBe(false);
    });

    it("greaterThan compares correctly", () => {
      const a = Credit.fromRaw(10);
      const b = Credit.fromRaw(5);
      expect(a.greaterThan(b)).toBe(true);
      expect(b.greaterThan(a)).toBe(false);
    });

    it("lessThan compares correctly", () => {
      const a = Credit.fromRaw(5);
      const b = Credit.fromRaw(10);
      expect(a.lessThan(b)).toBe(true);
      expect(b.lessThan(a)).toBe(false);
    });

    it("equals compares correctly", () => {
      const a = Credit.fromRaw(42);
      const b = Credit.fromRaw(42);
      const c = Credit.fromRaw(43);
      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
    });

    it("equals: fromDollars(1) equals fromCents(100)", () => {
      expect(Credit.fromDollars(1).equals(Credit.fromCents(100))).toBe(true);
    });

    it("lessThanOrEqual compares correctly", () => {
      expect(Credit.fromCents(5).lessThanOrEqual(Credit.fromCents(5))).toBe(true);
      expect(Credit.fromCents(5).lessThanOrEqual(Credit.fromCents(10))).toBe(true);
      expect(Credit.fromCents(10).lessThanOrEqual(Credit.fromCents(5))).toBe(false);
    });

    it("greaterThanOrEqual compares correctly", () => {
      expect(Credit.fromCents(10).greaterThanOrEqual(Credit.fromCents(5))).toBe(true);
      expect(Credit.fromCents(5).greaterThanOrEqual(Credit.fromCents(5))).toBe(true);
      expect(Credit.fromCents(5).greaterThanOrEqual(Credit.fromCents(10))).toBe(false);
    });
  });

  describe("toString", () => {
    it("returns debug representation", () => {
      const c = Credit.fromRaw(123456);
      expect(c.toString()).toBe("Credit(raw=123456)");
    });
  });

  describe("toJSON", () => {
    it("toJSON returns raw value", () => {
      const c = Credit.fromDollars(1);
      expect(c.toJSON()).toBe(1_000_000_000);
      expect(JSON.stringify({ amount: c })).toBe('{"amount":1000000000}');
    });
  });

  describe("sub-cent precision proof", () => {
    it("$0.001 charge does not round to zero", () => {
      const charge = Credit.fromDollars(0.001);
      expect(charge.isZero()).toBe(false);
      expect(charge.toRaw()).toBe(1_000_000);
    });

    it("$0.000000001 charge (1 raw unit) does not round to zero", () => {
      const charge = Credit.fromDollars(0.000000001);
      expect(charge.isZero()).toBe(false);
      expect(charge.toRaw()).toBe(1);
    });

    it("old integer-cents would lose $0.001 but Credit preserves it", () => {
      // In old system: Math.round(0.001 * 100) = 0 cents (lost!)
      const oldCents = Math.round(0.001 * 100);
      expect(oldCents).toBe(0);

      // In new system: preserved
      const credit = Credit.fromDollars(0.001);
      expect(credit.toRaw()).toBe(1_000_000);
      expect(credit.isZero()).toBe(false);
    });

    it("accumulates sub-cent charges without loss", () => {
      const tiny = Credit.fromDollars(0.0001); // 100_000 raw
      let total = Credit.ZERO;
      for (let i = 0; i < 10_000; i++) {
        total = total.add(tiny);
      }
      expect(total.toDollars()).toBeCloseTo(1.0);
      expect(total.toRaw()).toBe(1_000_000_000);
    });
  });
});
