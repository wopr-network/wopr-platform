import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/credits.js";
import { Credit } from "../credit.js";

export interface ICreditTransactionRepository {
  /** Check if any transaction exists with a referenceId matching a LIKE pattern. */
  existsByReferenceIdLike(pattern: string): Promise<boolean>;
  /** Sum amount for 'purchase' transactions within [startTs, endTs). */
  sumPurchasesForPeriod(startTs: string, endTs: string): Promise<Credit>;
  /** Get distinct tenantIds that had a 'purchase' transaction within [startTs, endTs). */
  getActiveTenantIdsInWindow(startTs: string, endTs: string): Promise<string[]>;
}

export class DrizzleCreditTransactionRepository implements ICreditTransactionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async existsByReferenceIdLike(pattern: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(sql`${creditTransactions.referenceId} LIKE ${pattern}`)
        .limit(1)
    )[0];
    return row != null;
  }

  async sumPurchasesForPeriod(startTs: string, endTs: string): Promise<Credit> {
    const row = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${creditTransactions.amount}), 0)`,
        })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.type, "purchase"),
            gte(creditTransactions.createdAt, startTs),
            lt(creditTransactions.createdAt, endTs),
          ),
        )
    )[0];
    return Credit.fromRaw(Math.round(row?.total ?? 0));
  }

  async getActiveTenantIdsInWindow(startTs: string, endTs: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({
        tenantId: creditTransactions.tenantId,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, "purchase"),
          gte(creditTransactions.createdAt, startTs),
          lt(creditTransactions.createdAt, endTs),
        ),
      );
    return rows.map((r) => r.tenantId);
  }
}
