import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopup } from "../../db/schema/credit-auto-topup.js";
import { creditBalances, creditTransactions } from "../../db/schema/credits.js";
import { meterEvents } from "../../db/schema/meter-events.js";
import { tenantStatus } from "../../db/schema/tenant-status.js";

/** Raw row shapes returned by the repository — no business-logic transforms. */
export interface RawScalarResult {
  total: number;
}

export interface RawRevenueBreakdownRow {
  category: string;
  capability: string;
  revenueCents: number;
}

export interface RawMarginRow {
  capability: string;
  revenueCents: number;
  costCents: number;
}

export interface RawProviderSpendRow {
  provider: string;
  callCount: number;
  spendCents: number;
}

export interface RawAutoTopupRow {
  totalEvents: number;
  successCount: number;
  failedCount: number;
  revenueCents: number;
}

export interface RawTimeSeriesMeterRow {
  periodStart: number;
  perUseRevenueCents: number;
  providerCostCents: number;
}

export interface RawTimeSeriesCreditRow {
  periodStart: number;
  creditsSoldRaw: number;
  monthlyRevenueRaw: number;
}

export interface IAnalyticsRepository {
  /** SUM of purchase credits in range (raw nanodollars — caller divides by 10_000_000) */
  sumCreditsPurchased(fromIso: string, toIso: string): Promise<number>;

  /** SUM of consumed credits in range (raw nanodollars — caller divides by 10_000_000) */
  sumCreditsConsumed(fromIso: string, toIso: string): Promise<number>;

  /** SUM of provider cost in cents from meter_events in range */
  sumProviderCostCents(fromMs: number, toMs: number): Promise<number>;

  /** Float: count + sum of balances where balance > 0 */
  getFloatBalances(): Promise<{ tenantCount: number; totalFloatRaw: number }>;

  /** All-time sum of purchase credits (raw nanodollars) */
  sumAllTimeCreditsPurchased(): Promise<number>;

  /** Per-use revenue breakdown from meter_events grouped by capability */
  getPerUseRevenueBreakdown(fromMs: number, toMs: number): Promise<RawRevenueBreakdownRow[]>;

  /** Monthly revenue breakdown from credit_transactions grouped by capability */
  getMonthlyRevenueBreakdown(fromIso: string, toIso: string): Promise<RawRevenueBreakdownRow[]>;

  /** Margin by capability from meter_events */
  getMarginByCapability(fromMs: number, toMs: number): Promise<RawMarginRow[]>;

  /** Provider spend from meter_events */
  getProviderSpend(fromMs: number, toMs: number): Promise<RawProviderSpendRow[]>;

  /** Total distinct tenants (union of credit_balances + tenant_status) */
  countTotalTenants(): Promise<number>;

  /** Active tenants (distinct tenants with negative credit_transactions in last 30 days) */
  countActiveTenants(sinceIso: string): Promise<number>;

  /** Tenants with positive balance */
  countTenantsWithBalance(): Promise<number>;

  /** At-risk tenants (low balance, no successful auto-topup) */
  countAtRiskTenants(): Promise<number>;

  /** Auto-topup aggregate metrics */
  getAutoTopupMetrics(fromIso: string, toIso: string): Promise<RawAutoTopupRow>;

  /** Time series meter data bucketed by effectiveBucketMs */
  getTimeSeriesMeter(fromMs: number, toMs: number, bucketMs: number): Promise<RawTimeSeriesMeterRow[]>;

  /** Time series credit data bucketed by effectiveBucketMs */
  getTimeSeriesCredits(fromIso: string, toIso: string, bucketMs: number): Promise<RawTimeSeriesCreditRow[]>;
}

export class DrizzleAnalyticsRepository implements IAnalyticsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async sumCreditsPurchased(fromIso: string, toIso: string): Promise<number> {
    // creditTransactions.amount is a Credit custom column — use sql for numeric comparisons
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${creditTransactions.amount}), 0)::bigint` })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, "purchase"),
          sql`${creditTransactions.amount} > 0`,
          gte(creditTransactions.createdAt, fromIso),
          lte(creditTransactions.createdAt, toIso),
        ),
      );
    return Number(result[0]?.total ?? 0);
  }

  async sumCreditsConsumed(fromIso: string, toIso: string): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(ABS(${creditTransactions.amount})), 0)::bigint` })
      .from(creditTransactions)
      .where(
        and(
          sql`${creditTransactions.type} IN ('bot_runtime', 'adapter_usage', 'addon')`,
          gte(creditTransactions.createdAt, fromIso),
          lte(creditTransactions.createdAt, toIso),
        ),
      );
    return Number(result[0]?.total ?? 0);
  }

  async sumProviderCostCents(fromMs: number, toMs: number): Promise<number> {
    // meter_events.cost stores nanodollars (Credit.toRaw()); divide by 10_000_000 to get cents
    const result = await this.db
      .select({ total: sql<number>`CAST(COALESCE(SUM(${meterEvents.cost}) / 10000000, 0) AS BIGINT)` })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, fromMs), lte(meterEvents.timestamp, toMs)));
    return Number(result[0]?.total ?? 0);
  }

  async getFloatBalances(): Promise<{ tenantCount: number; totalFloatRaw: number }> {
    // creditBalances.balance is a Credit custom column — use sql for numeric comparisons
    const result = await this.db
      .select({
        tenantCount: sql<number>`COUNT(*)::bigint`,
        totalFloatRaw: sql<number>`COALESCE(SUM(${creditBalances.balance}), 0)::bigint`,
      })
      .from(creditBalances)
      .where(sql`${creditBalances.balance} > 0`);
    return {
      tenantCount: Number(result[0]?.tenantCount ?? 0),
      totalFloatRaw: Number(result[0]?.totalFloatRaw ?? 0),
    };
  }

  async sumAllTimeCreditsPurchased(): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${creditTransactions.amount}), 0)::bigint` })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.type, "purchase"), sql`${creditTransactions.amount} > 0`));
    return Number(result[0]?.total ?? 0);
  }

  async getPerUseRevenueBreakdown(fromMs: number, toMs: number): Promise<RawRevenueBreakdownRow[]> {
    // meter_events.charge stores nanodollars (Credit.toRaw()); divide by 10_000_000 to get cents
    const rows = await this.db
      .select({
        capability: meterEvents.capability,
        revenueCents: sql<number>`CAST(COALESCE(SUM(${meterEvents.charge}) / 10000000, 0) AS BIGINT)`,
      })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, fromMs), lte(meterEvents.timestamp, toMs)))
      .groupBy(meterEvents.capability)
      .orderBy(sql`2 DESC`);
    return rows.map((r) => ({
      category: "per_use",
      capability: r.capability,
      revenueCents: Number(r.revenueCents),
    }));
  }

  async getMonthlyRevenueBreakdown(fromIso: string, toIso: string): Promise<RawRevenueBreakdownRow[]> {
    const rows = await this.db
      .select({
        // raw SQL: Drizzle cannot express CASE/WHEN column aliasing
        capability: sql<string>`CASE WHEN ${creditTransactions.type} = 'bot_runtime' THEN 'agent_seat' WHEN ${creditTransactions.type} = 'addon' THEN 'addon' ELSE ${creditTransactions.type} END`,
        revenueCents: sql<number>`COALESCE(SUM(ABS(${creditTransactions.amount})), 0)::bigint`,
      })
      .from(creditTransactions)
      .where(
        and(
          sql`${creditTransactions.type} IN ('bot_runtime', 'addon')`,
          gte(creditTransactions.createdAt, fromIso),
          lte(creditTransactions.createdAt, toIso),
        ),
      )
      .groupBy(
        sql`CASE WHEN ${creditTransactions.type} = 'bot_runtime' THEN 'agent_seat' WHEN ${creditTransactions.type} = 'addon' THEN 'addon' ELSE ${creditTransactions.type} END`,
      )
      .orderBy(sql`2 DESC`);
    return rows.map((r) => ({
      category: "monthly",
      capability: r.capability,
      revenueCents: Number(r.revenueCents),
    }));
  }

  async getMarginByCapability(fromMs: number, toMs: number): Promise<RawMarginRow[]> {
    // meter_events stores nanodollars (Credit.toRaw()); divide by 10_000_000 to get cents
    const rows = await this.db
      .select({
        capability: meterEvents.capability,
        revenueCents: sql<number>`CAST(COALESCE(SUM(${meterEvents.charge}) / 10000000, 0) AS BIGINT)`,
        costCents: sql<number>`CAST(COALESCE(SUM(${meterEvents.cost}) / 10000000, 0) AS BIGINT)`,
      })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, fromMs), lte(meterEvents.timestamp, toMs)))
      .groupBy(meterEvents.capability)
      .orderBy(sql`2 DESC`);
    return rows.map((r) => ({
      capability: r.capability,
      revenueCents: Number(r.revenueCents),
      costCents: Number(r.costCents),
    }));
  }

  async getProviderSpend(fromMs: number, toMs: number): Promise<RawProviderSpendRow[]> {
    // meter_events.cost stores nanodollars (Credit.toRaw()); divide by 10_000_000 to get cents
    const rows = await this.db
      .select({
        provider: meterEvents.provider,
        callCount: sql<number>`COUNT(*)::bigint`,
        spendCents: sql<number>`CAST(COALESCE(SUM(${meterEvents.cost}) / 10000000, 0) AS BIGINT)`,
      })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, fromMs), lte(meterEvents.timestamp, toMs)))
      .groupBy(meterEvents.provider)
      .orderBy(sql`3 DESC`);
    return rows.map((r) => ({
      provider: r.provider,
      callCount: Number(r.callCount),
      spendCents: Number(r.spendCents),
    }));
  }

  async countTotalTenants(): Promise<number> {
    // raw SQL: Drizzle cannot express COUNT over UNION subquery cleanly
    const result = await this.db
      .select({ total: sql<number>`COUNT(*)::bigint` })
      .from(
        sql`(SELECT ${creditBalances.tenantId} as tenant_id FROM ${creditBalances} UNION SELECT ${tenantStatus.tenantId} as tenant_id FROM ${tenantStatus}) t`,
      );
    return Number(result[0]?.total ?? 0);
  }

  async countActiveTenants(sinceIso: string): Promise<number> {
    // creditTransactions.amount is a Credit custom column — use sql for numeric comparisons
    const result = await this.db
      .select({ active: sql<number>`COUNT(DISTINCT ${creditTransactions.tenantId})::bigint` })
      .from(creditTransactions)
      .where(and(sql`${creditTransactions.amount} < 0`, gte(creditTransactions.createdAt, sinceIso)));
    return Number(result[0]?.active ?? 0);
  }

  async countTenantsWithBalance(): Promise<number> {
    const result = await this.db
      .select({ withBalance: sql<number>`COUNT(*)::bigint` })
      .from(creditBalances)
      .where(sql`${creditBalances.balance} > 0`);
    return Number(result[0]?.withBalance ?? 0);
  }

  async countAtRiskTenants(): Promise<number> {
    // raw SQL: Drizzle cannot express NOT IN (SELECT DISTINCT ...) cleanly
    // 5_000_000_000 nanodollars = $5.00 = 500 cents (low balance threshold)
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)::bigint` })
      .from(creditBalances)
      .where(
        and(
          sql`${creditBalances.balance} > 0`,
          sql`${creditBalances.balance} < 5000000000`,
          sql`${creditBalances.tenantId} NOT IN (SELECT DISTINCT tenant_id FROM credit_auto_topup WHERE status = 'success')`,
        ),
      );
    return Number(result[0]?.count ?? 0);
  }

  async getAutoTopupMetrics(fromIso: string, toIso: string): Promise<RawAutoTopupRow> {
    // credit_auto_topup.amountCents is integer cents (Stripe payment amount)
    const rows = await this.db
      .select({
        totalEvents: sql<number>`COUNT(*)::bigint`,
        successCount: sql<number>`COALESCE(SUM(CASE WHEN ${creditAutoTopup.status} = 'success' THEN 1 ELSE 0 END), 0)::bigint`,
        failedCount: sql<number>`COALESCE(SUM(CASE WHEN ${creditAutoTopup.status} = 'failed' THEN 1 ELSE 0 END), 0)::bigint`,
        revenueCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditAutoTopup.status} = 'success' THEN ${creditAutoTopup.amountCents} ELSE 0 END), 0)::bigint`,
      })
      .from(creditAutoTopup)
      .where(and(gte(creditAutoTopup.createdAt, fromIso), lte(creditAutoTopup.createdAt, toIso)));
    const row = rows[0];
    return {
      totalEvents: Number(row?.totalEvents ?? 0),
      successCount: Number(row?.successCount ?? 0),
      failedCount: Number(row?.failedCount ?? 0),
      revenueCents: Number(row?.revenueCents ?? 0),
    };
  }

  async getTimeSeriesMeter(fromMs: number, toMs: number, bucketMs: number): Promise<RawTimeSeriesMeterRow[]> {
    // raw SQL: Drizzle cannot express FLOOR-based bucketing natively
    // meter_events stores nanodollars (Credit.toRaw()); divide by 10_000_000 to get cents
    const rows = await this.db
      .select({
        periodStart: sql<number>`(FLOOR(${meterEvents.timestamp}::numeric / ${bucketMs})::bigint * ${bucketMs})`,
        perUseRevenueCents: sql<number>`CAST(COALESCE(SUM(${meterEvents.charge}) / 10000000, 0) AS BIGINT)`,
        providerCostCents: sql<number>`CAST(COALESCE(SUM(${meterEvents.cost}) / 10000000, 0) AS BIGINT)`,
      })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, fromMs), lte(meterEvents.timestamp, toMs)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((r) => ({
      periodStart: Number(r.periodStart),
      perUseRevenueCents: Number(r.perUseRevenueCents),
      providerCostCents: Number(r.providerCostCents),
    }));
  }

  async getTimeSeriesCredits(fromIso: string, toIso: string, bucketMs: number): Promise<RawTimeSeriesCreditRow[]> {
    // raw SQL: Drizzle cannot express FLOOR-based bucketing natively
    const rows = await this.db
      .select({
        periodStart: sql<number>`(FLOOR(EXTRACT(EPOCH FROM ${creditTransactions.createdAt}::timestamptz) * 1000 / ${bucketMs})::bigint * ${bucketMs})`,
        creditsSoldRaw: sql<number>`COALESCE(SUM(CASE WHEN ${creditTransactions.type} = 'purchase' AND ${creditTransactions.amount} > 0 THEN ${creditTransactions.amount} ELSE 0 END), 0)::bigint`,
        monthlyRevenueRaw: sql<number>`COALESCE(SUM(CASE WHEN ${creditTransactions.type} IN ('bot_runtime', 'addon') THEN ABS(${creditTransactions.amount}) ELSE 0 END), 0)::bigint`,
      })
      .from(creditTransactions)
      .where(and(gte(creditTransactions.createdAt, fromIso), lte(creditTransactions.createdAt, toIso)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((r) => ({
      periodStart: Number(r.periodStart),
      creditsSoldRaw: Number(r.creditsSoldRaw),
      monthlyRevenueRaw: Number(r.monthlyRevenueRaw),
    }));
  }
}
