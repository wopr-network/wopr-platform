import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/credits.js";

export interface ICreditTransactionRepository {
  /** Check if any transaction exists with a referenceId matching a LIKE pattern. */
  existsByReferenceIdLike(pattern: string): Promise<boolean>;
  /** Sum amountCredits for 'purchase' transactions within [startTs, endTs). */
  sumPurchasesForPeriod(startTs: string, endTs: string): Promise<number>;
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

  async sumPurchasesForPeriod(startTs: string, endTs: string): Promise<number> {
    const row = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${creditTransactions.amountCredits}), 0)`,
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
    return row?.total ?? 0;
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
