import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/credits.js";
import { usageSummaries } from "../../db/schema/meter-events.js";

// ---------------------------------------------------------------------------
// IUsageSummaryRepository
// ---------------------------------------------------------------------------

export interface AggregatedCharge {
  tenant: string;
  totalChargeRaw: number;
}

export interface IUsageSummaryRepository {
  /** Sum metered charges per tenant for windows overlapping [windowStart, windowEnd). */
  getAggregatedChargesByWindow(windowStart: number, windowEnd: number): Promise<AggregatedCharge[]>;
}

export class DrizzleUsageSummaryRepository implements IUsageSummaryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getAggregatedChargesByWindow(windowStart: number, windowEnd: number): Promise<AggregatedCharge[]> {
    const rows = await this.db
      .select({
        tenant: usageSummaries.tenant,
        totalCharge: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
      })
      .from(usageSummaries)
      .where(
        and(
          gte(usageSummaries.windowStart, windowStart),
          lt(usageSummaries.windowEnd, windowEnd),
          ne(usageSummaries.tenant, "__sentinel__"),
        ),
      )
      .groupBy(usageSummaries.tenant);

    return rows.map((r) => ({ tenant: r.tenant, totalChargeRaw: Number(r.totalCharge) }));
  }
}

// ---------------------------------------------------------------------------
// IAdapterUsageRepository
// ---------------------------------------------------------------------------

export interface AggregatedDebit {
  tenantId: string;
  totalDebitRaw: number;
}

export interface IAdapterUsageRepository {
  /** Sum adapter_usage debits per tenant within [startIso, endIso). */
  getAggregatedAdapterUsageDebits(startIso: string, endIso: string): Promise<AggregatedDebit[]>;
}

export class DrizzleAdapterUsageRepository implements IAdapterUsageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getAggregatedAdapterUsageDebits(startIso: string, endIso: string): Promise<AggregatedDebit[]> {
    const rows = await this.db
      .select({
        tenantId: creditTransactions.tenantId,
        // amount_credits stores negative values for debits; ABS gives the raw positive debit amount.
        // Use the raw column name in sql to bypass the custom creditColumn type serializer.
        totalDebitRaw: sql<number>`COALESCE(SUM(ABS(amount_credits)), 0)`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, "adapter_usage"),
          sql`${creditTransactions.createdAt}::timestamptz >= ${startIso}::timestamptz`,
          sql`${creditTransactions.createdAt}::timestamptz < ${endIso}::timestamptz`,
        ),
      )
      .groupBy(creditTransactions.tenantId);

    return rows.map((r) => ({ tenantId: r.tenantId, totalDebitRaw: Number(r.totalDebitRaw) }));
  }
}
