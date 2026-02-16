/**
 * Value Object: TenantId
 * 
 * Immutable identifier for tenants with validation.
 * Prevents mixing up different types of IDs (tenant vs user vs bot).
 */
export class TenantId {
  private constructor(private readonly value: string) {}

  /**
   * Create a TenantId from a string value.
   * @throws Error if value is empty or invalid
   */
  static create(value: string): TenantId {
    if (!value || value.length === 0) {
      throw new Error('TenantId cannot be empty');
    }
    if (value.length > 256) {
      throw new Error('TenantId cannot exceed 256 characters');
    }
    return new TenantId(value);
  }

  /**
   * Compare two TenantIds for equality.
   */
  equals(other: TenantId): boolean {
    return this.value === other.value;
  }

  /**
   * Get the raw string value.
   * Use sparingly - prefer passing TenantId objects.
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
