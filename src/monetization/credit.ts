import { logger } from "../config/logger.js";

/**
 * Credit value object with sub-cent precision.
 *
 * SCALE = 1,000,000,000 raw units per dollar (nano-dollars).
 * All arithmetic operates on integer raw units -- no floating point
 * in arithmetic paths. Math.round() is used only at input boundaries
 * (fromDollars, fromCents, multiply).
 *
 * @example
 * ```ts
 * const charge = Credit.fromDollars(0.001); // 1,000,000 raw units
 * const balance = Credit.fromCents(500);     // 5,000,000,000 raw units
 * const remaining = balance.subtract(charge);
 * ```
 */
export class Credit {
  static readonly SCALE = 1_000_000_000;

  private constructor(private readonly raw: number) {}

  /** Zero credit (static readonly instance to avoid allocation per access). */
  static readonly ZERO = new Credit(0);

  /** Create from dollar amount. Rounds to nearest raw unit. */
  static fromDollars(dollars: number): Credit {
    return new Credit(Math.round(dollars * Credit.SCALE));
  }

  /** Create from cent amount. Rounds to nearest raw unit. */
  static fromCents(cents: number): Credit {
    return new Credit(Math.round(cents * (Credit.SCALE / 100)));
  }

  // Tiered balance thresholds (in raw units) for observability warnings.
  private static readonly WARN_10K = 10_000 * Credit.SCALE; // $10,000
  private static readonly WARN_100K = 100_000 * Credit.SCALE; // $100,000
  private static readonly WARN_1M = 1_000_000 * Credit.SCALE; // $1,000,000

  /** Create from raw integer units. Throws TypeError if not integer. */
  static fromRaw(raw: number): Credit {
    if (!Number.isInteger(raw)) {
      throw new TypeError(`Credit.fromRaw requires an integer, got ${raw}`);
    }
    if (raw > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Credit.fromRaw value ${raw} exceeds MAX_SAFE_INTEGER — bigint migration required`);
    }
    const dollars = raw / Credit.SCALE;
    if (raw >= Credit.WARN_1M) {
      logger.warn("Credit balance WTF threshold reached — consider bigint migration", { dollars: dollars.toFixed(2) });
    } else if (raw >= Credit.WARN_100K) {
      logger.warn("Credit balance HIGH threshold reached — monitor for overflow", { dollars: dollars.toFixed(2) });
    } else if (raw >= Credit.WARN_10K) {
      logger.info("Credit balance large threshold reached", { dollars: dollars.toFixed(2) });
    }
    return new Credit(raw);
  }

  /** Zero credit (factory method alias for Credit.ZERO). */
  static zero(): Credit {
    return Credit.ZERO;
  }

  /** Convert to dollars (floating point, for display only). */
  toDollars(): number {
    return this.raw / Credit.SCALE;
  }

  /** Convert to cents (floating point, for display only). */
  toCents(): number {
    return this.raw / (Credit.SCALE / 100);
  }

  /**
   * Convert to cents, rounded to nearest integer (Math.round).
   * Use for display values and API responses where exact cent is needed.
   */
  toCentsRounded(): number {
    return Math.round(this.raw / (Credit.SCALE / 100));
  }

  /**
   * Convert to cents, floored to integer (Math.floor).
   * Use when sending amounts to Stripe/Payram — floor avoids charging
   * more than the displayed amount.
   */
  toCentsFloor(): number {
    return Math.floor(this.raw / (Credit.SCALE / 100));
  }

  /** Display as dollar amount with two decimal places. */
  toDisplayString(): string {
    return `$${this.toDollars().toFixed(2)}`;
  }

  /** Raw integer units (what gets stored in the database). */
  toRaw(): number {
    return this.raw;
  }

  /** Add another Credit, returning a new Credit. */
  add(other: Credit): Credit {
    return new Credit(this.raw + other.raw);
  }

  /** Subtract another Credit, returning a new Credit (may be negative). */
  subtract(other: Credit): Credit {
    return new Credit(this.raw - other.raw);
  }

  /** Multiply by a factor, rounding to nearest raw unit. */
  multiply(factor: number): Credit {
    return new Credit(Math.round(this.raw * factor));
  }

  /** True if this credit is negative. */
  isNegative(): boolean {
    return this.raw < 0;
  }

  /** True if this credit is exactly zero. */
  isZero(): boolean {
    return this.raw === 0;
  }

  /** True if this credit is greater than other. */
  greaterThan(other: Credit): boolean {
    return this.raw > other.raw;
  }

  /** True if this credit is less than other. */
  lessThan(other: Credit): boolean {
    return this.raw < other.raw;
  }

  /** True if this credit equals other. */
  equals(other: Credit): boolean {
    return this.raw === other.raw;
  }

  /** True if this credit is greater than or equal to other. */
  greaterThanOrEqual(other: Credit): boolean {
    return this.raw >= other.raw;
  }

  /** True if this credit is less than or equal to other. */
  lessThanOrEqual(other: Credit): boolean {
    return this.raw <= other.raw;
  }

  toString(): string {
    return `Credit(raw=${this.raw})`;
  }

  /** Serialize to raw integer for JSON (API responses, database). */
  toJSON(): number {
    return this.raw;
  }
}
