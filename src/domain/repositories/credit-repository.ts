/**
 * Repository Interface: CreditRepository (ASYNC)
 *
 * All operations are async for future flexibility.
 * Implementations can be sync underneath (better-sqlite3) or truly async (PostgreSQL, etc).
 */

import type { CreditBalance } from "../entities/credit-balance.js";
import type { CreditTransaction, CreditType, DebitType } from "../entities/credit-transaction.js";
import type { Money } from "../value-objects/money.js";
import type { TenantId } from "../value-objects/tenant-id.js";

export interface HistoryOptions {
  limit?: number;
  offset?: number;
  type?: string;
}

export interface TransactionPage {
  transactions: CreditTransaction[];
  totalCount: number;
  hasMore: boolean;
}

export interface TenantBalance {
  tenantId: TenantId;
  balance: Money;
}

export interface CreditRepository {
  credit(
    tenantId: TenantId,
    amount: Money,
    type: CreditType,
    description?: string,
    referenceId?: string,
  ): Promise<CreditTransaction>;

  debit(
    tenantId: TenantId,
    amount: Money,
    type: DebitType,
    description?: string,
    referenceId?: string,
  ): Promise<CreditTransaction>;

  getBalance(tenantId: TenantId): Promise<CreditBalance>;

  getTransactionHistory(tenantId: TenantId, options?: HistoryOptions): Promise<TransactionPage>;

  hasSufficientBalance(tenantId: TenantId, amount: Money): Promise<boolean>;

  hasReferenceId(referenceId: string): Promise<boolean>;

  getTenantsWithPositiveBalance(): Promise<TenantBalance[]>;
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly tenantId: TenantId,
    public readonly currentBalance: Money,
    public readonly requestedAmount: Money,
  ) {
    super(
      `Insufficient balance for tenant ${tenantId}: ` +
        `current ${currentBalance.format()}, requested ${requestedAmount.format()}`,
    );
    this.name = "InsufficientBalanceError";
  }
}
