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

  /** Create from raw integer units. Throws TypeError if not integer. */
  static fromRaw(raw: number): Credit {
    if (!Number.isInteger(raw)) {
      throw new TypeError(`Credit.fromRaw requires an integer, got ${raw}`);
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

  toString(): string {
    return `Credit(raw=${this.raw})`;
  }

  /** Serialize to raw integer for JSON (API responses, database). */
  toJSON(): number {
    return this.raw;
  }
}
