import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/credits.js";

export interface ICreditTransactionRepository {
  /** Check if any transaction exists with a referenceId matching a LIKE pattern. */
  existsByReferenceIdLike(pattern: string): boolean;
  /** Sum amountCents for 'purchase' transactions within [startTs, endTs). */
  sumPurchasesForPeriod(startTs: string, endTs: string): number;
  /** Get distinct tenantIds that had a 'purchase' transaction within [startTs, endTs). */
  getActiveTenantIdsInWindow(startTs: string, endTs: string): string[];
}

export class DrizzleCreditTransactionRepository implements ICreditTransactionRepository {
  constructor(private readonly db: DrizzleDb) {}

  existsByReferenceIdLike(pattern: string): boolean {
    const row = this.db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(sql`${creditTransactions.referenceId} LIKE ${pattern}`)
      .limit(1)
      .get();
    return row != null;
  }

  sumPurchasesForPeriod(startTs: string, endTs: string): number {
    const row = this.db
      .select({
        total: sql<number>`COALESCE(SUM(${creditTransactions.amountCents}), 0)`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, "purchase"),
          gte(creditTransactions.createdAt, startTs),
          lt(creditTransactions.createdAt, endTs),
        ),
      )
      .get();
    return row?.total ?? 0;
  }

  getActiveTenantIdsInWindow(startTs: string, endTs: string): string[] {
    const rows = this.db
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
      )
      .all();
    return rows.map((r) => r.tenantId);
  }
}
