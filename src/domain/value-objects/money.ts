/**
 * Value Object: Money
 *
 * Immutable representation of monetary amounts in cents.
 * Prevents floating point errors and provides type safety.
 */
export class Money {
  private constructor(private readonly cents: number) {}

  /**
   * Create Money from cents (integer).
   * @throws Error if cents is negative or not an integer
   */
  static fromCents(cents: number): Money {
    if (!Number.isInteger(cents)) {
      throw new Error("Money cents must be an integer");
    }
    if (cents < 0) {
      throw new Error("Money cannot be negative");
    }
    return new Money(cents);
  }

  /**
   * Create Money from dollars (decimal).
   * Rounds to nearest cent.
   * @throws Error if dollars is negative
   */
  static fromDollars(dollars: number): Money {
    if (dollars < 0) {
      throw new Error("Money cannot be negative");
    }
    return new Money(Math.round(dollars * 100));
  }

  /**
   * Zero dollars.
   */
  static zero(): Money {
    return new Money(0);
  }

  /**
   * Add two amounts of money.
   */
  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  /**
   * Subtract money from this amount.
   * @throws Error if result would be negative
   */
  subtract(other: Money): Money {
    const result = this.cents - other.cents;
    if (result < 0) {
      throw new InsufficientFundsError(this, other);
    }
    return new Money(result);
  }

  /**
   * Check if this amount is greater than another.
   */
  isGreaterThan(other: Money): boolean {
    return this.cents > other.cents;
  }

  /**
   * Check if this amount is greater than or equal to another.
   */
  isGreaterThanOrEqual(other: Money): boolean {
    return this.cents >= other.cents;
  }

  /**
   * Get the amount in cents.
   */
  toCents(): number {
    return this.cents;
  }

  /**
   * Get the amount in dollars (decimal).
   */
  toDollars(): number {
    return this.cents / 100;
  }

  /**
   * Format as currency string.
   */
  format(currency: string = "USD"): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(this.toDollars());
  }

  /**
   * For JSON serialization.
   */
  toJSON(): { cents: number; dollars: number } {
    return {
      cents: this.cents,
      dollars: this.toDollars(),
    };
  }
}

/**
 * Error thrown when attempting to subtract more than available.
 */
export class InsufficientFundsError extends Error {
  constructor(
    public readonly available: Money,
    public readonly requested: Money,
  ) {
    super(`Insufficient funds: available ${available.format()}, requested ${requested.format()}`);
    this.name = "InsufficientFundsError";
  }
}
