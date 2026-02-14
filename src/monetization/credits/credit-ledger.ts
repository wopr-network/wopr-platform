import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditBalances, creditTransactions } from "../../db/schema/credits.js";

/** Transaction types that add credits */
export type CreditType = "signup_grant" | "purchase" | "bounty" | "referral" | "promo";

/** Transaction types that remove credits */
export type DebitType = "bot_runtime" | "adapter_usage" | "addon" | "refund" | "correction";

export type TransactionType = CreditType | DebitType;

export interface CreditTransaction {
  id: string;
  tenantId: string;
  amountCents: number;
  balanceAfterCents: number;
  type: string;
  description: string | null;
  referenceId: string | null;
  createdAt: string;
}

export interface HistoryOptions {
  limit?: number;
  offset?: number;
  type?: string;
}

/** Insufficient balance error — thrown when a debit would make balance negative. */
export class InsufficientBalanceError extends Error {
  currentBalance: number;
  requestedAmount: number;

  constructor(currentBalance: number, requestedAmount: number) {
    super(`Insufficient balance: current ${currentBalance} cents, requested debit ${requestedAmount} cents`);
    this.name = "InsufficientBalanceError";
    this.currentBalance = currentBalance;
    this.requestedAmount = requestedAmount;
  }
}

/**
 * Credit ledger — the single source of truth for credit balances.
 *
 * All mutations go through Drizzle transactions to ensure the
 * creditBalances row is always consistent with the sum of creditTransactions.
 * Zero raw SQL in application code.
 */
export class CreditLedger {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Add credits to a tenant's balance.
   * @returns The created transaction record.
   */
  credit(
    tenantId: string,
    amountCents: number,
    type: CreditType,
    description?: string,
    referenceId?: string,
  ): CreditTransaction {
    if (amountCents <= 0) {
      throw new Error("amountCents must be positive for credits");
    }

    return this.db.transaction((tx) => {
      // Upsert balance row
      const existing = tx
        .select({ balanceCents: creditBalances.balanceCents })
        .from(creditBalances)
        .where(eq(creditBalances.tenantId, tenantId))
        .get();

      const currentBalance = existing?.balanceCents ?? 0;
      const newBalance = currentBalance + amountCents;

      if (existing) {
        tx.update(creditBalances)
          .set({
            balanceCents: newBalance,
            lastUpdated: sql`(datetime('now'))`,
          })
          .where(eq(creditBalances.tenantId, tenantId))
          .run();
      } else {
        tx.insert(creditBalances)
          .values({
            tenantId,
            balanceCents: newBalance,
            lastUpdated: sql`(datetime('now'))`,
          })
          .run();
      }

      // Insert transaction record
      const txn: typeof creditTransactions.$inferInsert = {
        id: crypto.randomUUID(),
        tenantId,
        amountCents,
        balanceAfterCents: newBalance,
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
      };

      tx.insert(creditTransactions).values(txn).run();

      return {
        id: txn.id!,
        tenantId: txn.tenantId,
        amountCents: txn.amountCents,
        balanceAfterCents: txn.balanceAfterCents,
        type: txn.type,
        description: txn.description ?? null,
        referenceId: txn.referenceId ?? null,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Deduct credits from a tenant's balance.
   * Throws InsufficientBalanceError if balance would go negative.
   * @returns The created transaction record.
   */
  debit(
    tenantId: string,
    amountCents: number,
    type: DebitType,
    description?: string,
    referenceId?: string,
  ): CreditTransaction {
    if (amountCents <= 0) {
      throw new Error("amountCents must be positive for debits");
    }

    return this.db.transaction((tx) => {
      const existing = tx
        .select({ balanceCents: creditBalances.balanceCents })
        .from(creditBalances)
        .where(eq(creditBalances.tenantId, tenantId))
        .get();

      const currentBalance = existing?.balanceCents ?? 0;

      if (currentBalance < amountCents) {
        throw new InsufficientBalanceError(currentBalance, amountCents);
      }

      const newBalance = currentBalance - amountCents;

      // `existing` is guaranteed non-null here: if it were null, currentBalance
      // would be 0 and the InsufficientBalanceError above would have thrown.
      tx.update(creditBalances)
        .set({
          balanceCents: newBalance,
          lastUpdated: sql`(datetime('now'))`,
        })
        .where(eq(creditBalances.tenantId, tenantId))
        .run();

      const txn: typeof creditTransactions.$inferInsert = {
        id: crypto.randomUUID(),
        tenantId,
        amountCents: -amountCents, // negative for debits
        balanceAfterCents: newBalance,
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
      };

      tx.insert(creditTransactions).values(txn).run();

      return {
        id: txn.id!,
        tenantId: txn.tenantId,
        amountCents: txn.amountCents,
        balanceAfterCents: txn.balanceAfterCents,
        type: txn.type,
        description: txn.description ?? null,
        referenceId: txn.referenceId ?? null,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /** Get current balance in cents for a tenant. Returns 0 if tenant has no balance row. */
  balance(tenantId: string): number {
    const row = this.db
      .select({ balanceCents: creditBalances.balanceCents })
      .from(creditBalances)
      .where(eq(creditBalances.tenantId, tenantId))
      .get();

    return row?.balanceCents ?? 0;
  }

  /** Check if a reference ID has already been used (for idempotency). */
  hasReferenceId(referenceId: string): boolean {
    const row = this.db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, referenceId))
      .limit(1)
      .get();

    return row != null;
  }

  /** Get transaction history for a tenant with optional filtering and pagination. */
  history(tenantId: string, opts: HistoryOptions = {}): CreditTransaction[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 250);
    const offset = Math.max(0, opts.offset ?? 0);

    const conditions = [eq(creditTransactions.tenantId, tenantId)];
    if (opts.type) {
      conditions.push(eq(creditTransactions.type, opts.type));
    }

    return this.db
      .select()
      .from(creditTransactions)
      .where(and(...conditions))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
  }

  /** List all tenants with positive balance (for cron deduction). */
  tenantsWithBalance(): Array<{ tenantId: string; balanceCents: number }> {
    return this.db
      .select({
        tenantId: creditBalances.tenantId,
        balanceCents: creditBalances.balanceCents,
      })
      .from(creditBalances)
      .where(sql`${creditBalances.balanceCents} > 0`)
      .all();
  }
}
