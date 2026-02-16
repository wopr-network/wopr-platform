/**
 * Drizzle Implementation: CreditRepository (ASYNC API)
 * 
 * better-sqlite3 is synchronous, but we expose async API.
 * This allows swapping to PostgreSQL or other async databases later.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/index.js';
import { creditBalances, creditTransactions } from '../../db/schema/credits.js';
import type { CreditRepository, HistoryOptions, TransactionPage, TenantBalance } from '../../domain/repositories/credit-repository.js';
import { InsufficientBalanceError } from '../../domain/repositories/credit-repository.js';
import { TenantId } from '../../domain/value-objects/tenant-id.js';
import { Money } from '../../domain/value-objects/money.js';
import { TransactionId } from '../../domain/value-objects/transaction-id.js';
import { CreditTransaction, type CreditType, type DebitType } from '../../domain/entities/credit-transaction.js';
import { CreditBalance } from '../../domain/entities/credit-balance.js';

export class DrizzleCreditRepository implements CreditRepository {
  constructor(private readonly db: DrizzleDb) {}

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

    // better-sqlite3 transaction is synchronous, but we expose async API
    return this.db.transaction((tx) => {
      const existing = tx
        .select({ balanceCents: creditBalances.balanceCents })
        .from(creditBalances)
        .where(eq(creditBalances.tenantId, tenantId.toString()))
        .get();

      const currentBalanceCents = existing?.balanceCents ?? 0;
      const newBalanceCents = currentBalanceCents + amount.toCents();

      if (existing) {
        tx.update(creditBalances)
          .set({
            balanceCents: newBalanceCents,
            lastUpdated: sql`(datetime('now'))`,
          })
          .where(eq(creditBalances.tenantId, tenantId.toString()))
          .run();
      } else {
        tx.insert(creditBalances)
          .values({
            tenantId: tenantId.toString(),
            balanceCents: newBalanceCents,
            lastUpdated: sql`(datetime('now'))`,
          })
          .run();
      }

      const transactionId = TransactionId.generate();
      tx.insert(creditTransactions)
        .values({
          id: transactionId.toString(),
          tenantId: tenantId.toString(),
          amountCents: amount.toCents(),
          balanceAfterCents: newBalanceCents,
          type,
          description: description ?? null,
          referenceId: referenceId ?? null,
        })
        .run();

      return new CreditTransaction({
        id: transactionId,
        tenantId,
        amount,
        balanceAfter: Money.fromCents(newBalanceCents),
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
        createdAt: new Date(),
      });
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

    return this.db.transaction((tx) => {
      const existing = tx
        .select({ balanceCents: creditBalances.balanceCents })
        .from(creditBalances)
        .where(eq(creditBalances.tenantId, tenantId.toString()))
        .get();

      const currentBalanceCents = existing?.balanceCents ?? 0;

      if (currentBalanceCents < amount.toCents()) {
        throw new InsufficientBalanceError(
          tenantId,
          Money.fromCents(currentBalanceCents),
          amount
        );
      }

      const newBalanceCents = currentBalanceCents - amount.toCents();

      tx.update(creditBalances)
        .set({
          balanceCents: newBalanceCents,
          lastUpdated: sql`(datetime('now'))`,
        })
        .where(eq(creditBalances.tenantId, tenantId.toString()))
        .run();

      const transactionId = TransactionId.generate();
      tx.insert(creditTransactions)
        .values({
          id: transactionId.toString(),
          tenantId: tenantId.toString(),
          amountCents: -amount.toCents(),
          balanceAfterCents: newBalanceCents,
          type,
          description: description ?? null,
          referenceId: referenceId ?? null,
        })
        .run();

      return new CreditTransaction({
        id: transactionId,
        tenantId,
        amount,
        balanceAfter: Money.fromCents(newBalanceCents),
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
        createdAt: new Date(),
      });
    });
  }

  async getBalance(tenantId: TenantId): Promise<CreditBalance> {
    const row = this.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.tenantId, tenantId.toString()))
      .get();

    if (!row) {
      return CreditBalance.zero(tenantId);
    }

    return new CreditBalance({
      tenantId,
      balance: Money.fromCents(row.balanceCents),
      lastUpdated: new Date(row.lastUpdated),
    });
  }

  async getTransactionHistory(
    tenantId: TenantId,
    options: HistoryOptions = {}
  ): Promise<TransactionPage> {
    const { limit = 50, offset = 0, type } = options;

    const conditions = [eq(creditTransactions.tenantId, tenantId.toString())];
    
    if (type) {
      conditions.push(eq(creditTransactions.type, type));
    }

    const countResult = this.db
      .select({ count: sql<number>`count(*)` })
      .from(creditTransactions)
      .where(and(...conditions))
      .get();
    
    const totalCount = countResult?.count ?? 0;

    const rows = this.db
      .select()
      .from(creditTransactions)
      .where(and(...conditions))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    const transactions = rows.map((row) =>
      new CreditTransaction({
        id: TransactionId.fromString(row.id),
        tenantId,
        amount: Money.fromCents(Math.abs(row.amountCents)),
        balanceAfter: Money.fromCents(row.balanceAfterCents),
        type: row.type as CreditType | DebitType,
        description: row.description,
        referenceId: row.referenceId,
        createdAt: new Date(row.createdAt),
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
    const row = this.db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, referenceId))
      .limit(1)
      .get();

    return row != null;
  }

  async getTenantsWithPositiveBalance(): Promise<TenantBalance[]> {
    const rows = this.db
      .select({
        tenantId: creditBalances.tenantId,
        balanceCents: creditBalances.balanceCents,
      })
      .from(creditBalances)
      .where(sql`${creditBalances.balanceCents} > 0`)
      .all();

    return rows.map((row) => ({
      tenantId: TenantId.create(row.tenantId),
      balance: Money.fromCents(row.balanceCents),
    }));
  }
}
