/**
 * Repository Interface: CreditAdjustmentRepository (ASYNC)
 *
 * Manages credit adjustments (grants, refunds, corrections).
 */
export type AdjustmentType = "grant" | "refund" | "correction";

export interface CreditAdjustment {
  id: string;
  tenant: string;
  type: AdjustmentType;
  amount_cents: number;
  reason: string;
  admin_user: string;
  reference_ids: string | null;
  created_at: number;
}

export interface AdjustmentFilters {
  type?: AdjustmentType;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface CreditAdjustmentRepository {
  /**
   * Grant credits to a tenant.
   */
  grant(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): Promise<CreditAdjustment>;

  /**
   * Refund credits from a tenant.
   */
  refund(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): Promise<CreditAdjustment>;

  /**
   * Apply a balance correction.
   */
  correction(tenant: string, amountCents: number, reason: string, adminUser: string): Promise<CreditAdjustment>;

  /**
   * Get the current balance for a tenant in cents.
   */
  getBalance(tenant: string): Promise<number>;

  /**
   * List all transactions for a tenant.
   */
  listTransactions(
    tenant: string,
    filters?: AdjustmentFilters,
  ): Promise<{ entries: CreditAdjustment[]; total: number }>;

  /**
   * Get a single transaction by ID.
   */
  getTransaction(transactionId: string): Promise<CreditAdjustment | null>;

  /**
   * Check if a transaction with a given reference ID already exists.
   */
  hasReferenceId(referenceId: string): Promise<boolean>;
}
