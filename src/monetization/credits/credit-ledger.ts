import crypto from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditBalances, creditTransactions } from "../../db/schema/credits.js";

/** Transaction types that add credits */
export type CreditType =
  | "signup_grant"
  | "purchase"
  | "bounty"
  | "referral"
  | "promo"
  | "community_dividend"
  | "affiliate_bonus"
  | "affiliate_match";

/** Transaction types that remove credits */
export type DebitType =
  | "bot_runtime"
  | "adapter_usage"
  | "addon"
  | "refund"
  | "correction"
  | "resource_upgrade"
  | "storage_upgrade"
  | "onboarding_llm";

export type TransactionType = CreditType | DebitType;

export interface CreditTransaction {
  id: string;
  tenantId: string;
  amountCents: number;
  balanceAfterCents: number;
  type: string;
  description: string | null;
  referenceId: string | null;
  fundingSource: string | null;
  attributedUserId: string | null;
  createdAt: string;
}

export interface HistoryOptions {
  limit?: number;
  offset?: number;
  type?: string;
}

export interface MemberUsageSummary {
  userId: string;
  totalDebitCents: number;
  transactionCount: number;
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

export interface ICreditLedger {
  credit(
    tenantId: string,
    amountCents: number,
    type: CreditType,
    description?: string,
    referenceId?: string,
    fundingSource?: string,
    attributedUserId?: string,
  ): Promise<CreditTransaction>;

  debit(
    tenantId: string,
    amountCents: number,
    type: DebitType,
    description?: string,
    referenceId?: string,
    allowNegative?: boolean,
    attributedUserId?: string,
  ): Promise<CreditTransaction>;

  balance(tenantId: string): Promise<number>;
  hasReferenceId(referenceId: string): Promise<boolean>;
  history(tenantId: string, opts?: HistoryOptions): Promise<CreditTransaction[]>;
  tenantsWithBalance(): Promise<Array<{ tenantId: string; balanceCents: number }>>;
  memberUsage(tenantId: string): Promise<MemberUsageSummary[]>;
}

/**
 * Credit ledger — the single source of truth for credit balances.
 *
 * All mutations go through Drizzle transactions to ensure the
 * creditBalances row is always consistent with the sum of creditTransactions.
 * Zero raw SQL in application code.
 */
export class DrizzleCreditLedger implements ICreditLedger {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Add credits to a tenant's balance.
   * @returns The created transaction record.
   */
  async credit(
    tenantId: string,
    amountCents: number,
    type: CreditType,
    description?: string,
    referenceId?: string,
    fundingSource?: string,
    attributedUserId?: string,
  ): Promise<CreditTransaction> {
    if (amountCents <= 0) {
      throw new Error("amountCents must be positive for credits");
    }

    return this.db.transaction(async (tx) => {
      // Upsert balance row
      const existing = await tx
        .select({ balanceCents: creditBalances.balanceCents })
        .from(creditBalances)
        .where(eq(creditBalances.tenantId, tenantId));

      const currentBalance = existing[0]?.balanceCents ?? 0;
      const newBalance = currentBalance + amountCents;

      if (existing[0]) {
        await tx
          .update(creditBalances)
          .set({
            balanceCents: newBalance,
            lastUpdated: sql`(now())`,
          })
          .where(eq(creditBalances.tenantId, tenantId));
      } else {
        await tx.insert(creditBalances).values({
          tenantId,
          balanceCents: newBalance,
          lastUpdated: sql`(now())`,
        });
      }

      // Insert transaction record
      const id = crypto.randomUUID();
      const txn: typeof creditTransactions.$inferInsert = {
        id,
        tenantId,
        amountCents,
        balanceAfterCents: newBalance,
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
        fundingSource: fundingSource ?? null,
        attributedUserId: attributedUserId ?? null,
      };

      await tx.insert(creditTransactions).values(txn);

      return {
        id,
        tenantId: txn.tenantId,
        amountCents: txn.amountCents,
        balanceAfterCents: txn.balanceAfterCents,
        type: txn.type,
        description: txn.description ?? null,
        referenceId: txn.referenceId ?? null,
        fundingSource: txn.fundingSource ?? null,
        attributedUserId: txn.attributedUserId ?? null,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Deduct credits from a tenant's balance.
   * Throws InsufficientBalanceError if balance would go negative (unless allowNegative is true).
   * @param allowNegative - If true, allow balance to go negative (for grace buffer debits). Default: false.
   * @returns The created transaction record.
   */
  async debit(
    tenantId: string,
    amountCents: number,
    type: DebitType,
    description?: string,
    referenceId?: string,
    allowNegative?: boolean,
    attributedUserId?: string,
  ): Promise<CreditTransaction> {
    if (amountCents <= 0) {
      throw new Error("amountCents must be positive for debits");
    }

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ balanceCents: creditBalances.balanceCents })
        .from(creditBalances)
        .where(eq(creditBalances.tenantId, tenantId));

      const currentBalance = existing[0]?.balanceCents ?? 0;

      if (!allowNegative && currentBalance < amountCents) {
        throw new InsufficientBalanceError(currentBalance, amountCents);
      }

      const newBalance = currentBalance - amountCents;

      if (existing[0]) {
        await tx
          .update(creditBalances)
          .set({
            balanceCents: newBalance,
            lastUpdated: sql`(now())`,
          })
          .where(eq(creditBalances.tenantId, tenantId));
      } else {
        // allowNegative=true with no existing row — insert negative balance row
        await tx.insert(creditBalances).values({
          tenantId,
          balanceCents: newBalance,
          lastUpdated: sql`(now())`,
        });
      }

      const id = crypto.randomUUID();
      const txn: typeof creditTransactions.$inferInsert = {
        id,
        tenantId,
        amountCents: -amountCents, // negative for debits
        balanceAfterCents: newBalance,
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
        fundingSource: null,
        attributedUserId: attributedUserId ?? null,
      };

      await tx.insert(creditTransactions).values(txn);

      return {
        id,
        tenantId: txn.tenantId,
        amountCents: txn.amountCents,
        balanceAfterCents: txn.balanceAfterCents,
        type: txn.type,
        description: txn.description ?? null,
        referenceId: txn.referenceId ?? null,
        fundingSource: null,
        attributedUserId: txn.attributedUserId ?? null,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /** Get current balance in cents for a tenant. Returns 0 if tenant has no balance row. */
  async balance(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ balanceCents: creditBalances.balanceCents })
      .from(creditBalances)
      .where(eq(creditBalances.tenantId, tenantId));

    return rows[0]?.balanceCents ?? 0;
  }

  /** Check if a reference ID has already been used (for idempotency). */
  async hasReferenceId(referenceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, referenceId))
      .limit(1);

    return rows.length > 0;
  }

  /** Get transaction history for a tenant with optional filtering and pagination. */
  async history(tenantId: string, opts: HistoryOptions = {}): Promise<CreditTransaction[]> {
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
      .offset(offset);
  }

  /** Aggregate debit totals per attributed user for a tenant. */
  async memberUsage(tenantId: string): Promise<MemberUsageSummary[]> {
    const rows = await this.db
      .select({
        userId: creditTransactions.attributedUserId,
        totalDebitCents: sql<number>`COALESCE(SUM(ABS(${creditTransactions.amountCents})), 0)`,
        transactionCount: sql<number>`COUNT(*)`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.tenantId, tenantId),
          isNotNull(creditTransactions.attributedUserId),
          sql`${creditTransactions.amountCents} < 0`,
        ),
      )
      .groupBy(creditTransactions.attributedUserId);

    return rows
      .filter((r): r is typeof r & { userId: string } => r.userId != null)
      .map((r) => ({
        userId: r.userId,
        totalDebitCents: r.totalDebitCents,
        transactionCount: r.transactionCount,
      }));
  }

  /** List all tenants with positive balance (for cron deduction). */
  async tenantsWithBalance(): Promise<Array<{ tenantId: string; balanceCents: number }>> {
    return this.db
      .select({
        tenantId: creditBalances.tenantId,
        balanceCents: creditBalances.balanceCents,
      })
      .from(creditBalances)
      .where(sql`${creditBalances.balanceCents} > 0`);
  }
}

// Backward-compat alias — callers using 'new CreditLedger(db)' continue to work.
export { DrizzleCreditLedger as CreditLedger };
