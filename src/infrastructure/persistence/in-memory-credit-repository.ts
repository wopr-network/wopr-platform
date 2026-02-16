/**
 * In-Memory Implementation: CreditRepository (ASYNC)
 * 
 * For fast unit testing without database.
 */
import type { CreditRepository, HistoryOptions, TransactionPage, TenantBalance } from '../../domain/repositories/credit-repository.js';
import { InsufficientBalanceError } from '../../domain/repositories/credit-repository.js';
import { TenantId } from '../../domain/value-objects/tenant-id.js';
import { Money } from '../../domain/value-objects/money.js';
import { TransactionId } from '../../domain/value-objects/transaction-id.js';
import { CreditTransaction, type CreditType, type DebitType } from '../../domain/entities/credit-transaction.js';
import { CreditBalance } from '../../domain/entities/credit-balance.js';

interface StoredBalance {
  tenantId: string;
  balanceCents: number;
  lastUpdated: Date;
}

interface StoredTransaction {
  id: string;
  tenantId: string;
  amountCents: number;
  balanceAfterCents: number;
  type: string;
  description: string | null;
  referenceId: string | null;
  createdAt: Date;
  sequenceNumber: number; // For stable sort when timestamps are equal
}

export class InMemoryCreditRepository implements CreditRepository {
  private balances = new Map<string, StoredBalance>();
  private transactions: StoredTransaction[] = [];
  private sequenceCounter = 0;

  async credit(
    tenantId: TenantId,
    amount: Money,
    type: CreditType,
    description?: string,
    referenceId?: string
  ): Promise<CreditTransaction> {
    if (amount.toCents() <= 0) {
      throw new Error('Credit amount must be positive');
    }

    const tenantIdStr = tenantId.toString();
    const existing = this.balances.get(tenantIdStr);

    const currentBalanceCents = existing?.balanceCents ?? 0;
    const newBalanceCents = currentBalanceCents + amount.toCents();

    this.balances.set(tenantIdStr, {
      tenantId: tenantIdStr,
      balanceCents: newBalanceCents,
      lastUpdated: new Date(),
    });

    const transactionId = TransactionId.generate();
    const transaction: StoredTransaction = {
      id: transactionId.toString(),
      tenantId: tenantIdStr,
      amountCents: amount.toCents(),
      balanceAfterCents: newBalanceCents,
      type,
      description: description ?? null,
      referenceId: referenceId ?? null,
      createdAt: new Date(),
      sequenceNumber: ++this.sequenceCounter,
    };
    this.transactions.push(transaction);

    return new CreditTransaction({
      id: transactionId,
      tenantId,
      amount,
      balanceAfter: Money.fromCents(newBalanceCents),
      type,
      description: description ?? null,
      referenceId: referenceId ?? null,
      createdAt: transaction.createdAt,
    });
  }

  async debit(
    tenantId: TenantId,
    amount: Money,
    type: DebitType,
    description?: string,
    referenceId?: string
  ): Promise<CreditTransaction> {
    if (amount.toCents() <= 0) {
      throw new Error('Debit amount must be positive');
    }

    const tenantIdStr = tenantId.toString();
    const existing = this.balances.get(tenantIdStr);

    const currentBalanceCents = existing?.balanceCents ?? 0;

    if (currentBalanceCents < amount.toCents()) {
      throw new InsufficientBalanceError(
        tenantId,
        Money.fromCents(currentBalanceCents),
        amount
      );
    }

    const newBalanceCents = currentBalanceCents - amount.toCents();

    this.balances.set(tenantIdStr, {
      tenantId: tenantIdStr,
      balanceCents: newBalanceCents,
      lastUpdated: new Date(),
    });

    const transactionId = TransactionId.generate();
    const transaction: StoredTransaction = {
      id: transactionId.toString(),
      tenantId: tenantIdStr,
      amountCents: -amount.toCents(),
      balanceAfterCents: newBalanceCents,
      type,
      description: description ?? null,
      referenceId: referenceId ?? null,
      createdAt: new Date(),
      sequenceNumber: ++this.sequenceCounter,
    };
    this.transactions.push(transaction);

    return new CreditTransaction({
      id: transactionId,
      tenantId,
      amount,
      balanceAfter: Money.fromCents(newBalanceCents),
      type,
      description: description ?? null,
      referenceId: referenceId ?? null,
      createdAt: transaction.createdAt,
    });
  }

  async getBalance(tenantId: TenantId): Promise<CreditBalance> {
    const tenantIdStr = tenantId.toString();
    const stored = this.balances.get(tenantIdStr);

    if (!stored) {
      return CreditBalance.zero(tenantId);
    }

    return new CreditBalance({
      tenantId,
      balance: Money.fromCents(stored.balanceCents),
      lastUpdated: stored.lastUpdated,
    });
  }

  async getTransactionHistory(
    tenantId: TenantId,
    options: HistoryOptions = {}
  ): Promise<TransactionPage> {
    const { limit = 50, offset = 0, type } = options;
    const tenantIdStr = tenantId.toString();

    let filtered = this.transactions.filter((t) => t.tenantId === tenantIdStr);

    if (type) {
      filtered = filtered.filter((t) => t.type === type);
    }

    // Sort by createdAt desc (newest first), then by sequenceNumber desc for stable ordering
    filtered.sort((a, b) => {
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.sequenceNumber - a.sequenceNumber;
    });

    const totalCount = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    const transactions = paginated.map((t) =>
      new CreditTransaction({
        id: TransactionId.fromString(t.id),
        tenantId,
        amount: Money.fromCents(Math.abs(t.amountCents)),
        balanceAfter: Money.fromCents(t.balanceAfterCents),
        type: t.type as CreditType | DebitType,
        description: t.description,
        referenceId: t.referenceId,
        createdAt: t.createdAt,
      })
    );

    return {
      transactions,
      totalCount,
      hasMore: offset + transactions.length < totalCount,
    };
  }

  async hasSufficientBalance(tenantId: TenantId, amount: Money): Promise<boolean> {
    const balance = await this.getBalance(tenantId);
    return balance.balance.isGreaterThanOrEqual(amount);
  }

  async hasReferenceId(referenceId: string): Promise<boolean> {
    return this.transactions.some((t) => t.referenceId === referenceId);
  }

  async getTenantsWithPositiveBalance(): Promise<TenantBalance[]> {
    const result: TenantBalance[] = [];

    for (const [tenantIdStr, balance] of this.balances.entries()) {
      if (balance.balanceCents > 0) {
        result.push({
          tenantId: TenantId.create(tenantIdStr),
          balance: Money.fromCents(balance.balanceCents),
        });
      }
    }

    return result;
  }

  clear(): void {
    this.balances.clear();
    this.transactions = [];
  }

  getTransactionCount(): number {
    return this.transactions.length;
  }
}
