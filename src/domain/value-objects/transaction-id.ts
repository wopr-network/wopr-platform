/**
 * Value Object: TransactionId
 * 
 * Immutable identifier for transactions.
 */
export class TransactionId {
  private constructor(private readonly value: string) {}

  /**
   * Generate a new random TransactionId.
   */
  static generate(): TransactionId {
    return new TransactionId(crypto.randomUUID());
  }

  /**
   * Create from an existing string (e.g., from database).
   * @throws Error if value is empty
   */
  static fromString(value: string): TransactionId {
    if (!value || value.length === 0) {
      throw new Error('TransactionId cannot be empty');
    }
    return new TransactionId(value);
  }

  /**
   * Compare two TransactionIds for equality.
   */
  equals(other: TransactionId): boolean {
    return this.value === other.value;
  }

  /**
   * Get the raw string value.
   */
  toString(): string {
    return this.value;
  }

  /**
   * For JSON serialization.
   */
  toJSON(): string {
    return this.value;
  }
}
