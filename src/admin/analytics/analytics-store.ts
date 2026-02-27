import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";

type QueryResult = { rows: Array<Record<string, unknown>> };

async function exec(db: DrizzleDb, query: Parameters<DrizzleDb["execute"]>[0]): Promise<QueryResult> {
  return db.execute(query) as Promise<QueryResult>;
}

export interface DateRange {
  from: number; // unix epoch ms
  to: number; // unix epoch ms
}

export interface RevenueOverview {
  creditsSoldCents: number;
  revenueConsumedCents: number;
  providerCostCents: number;
  grossMarginCents: number;
  grossMarginPct: number;
}

/**
 * Float metrics compare the *current* outstanding credit balance against
 * *all-time* credits ever sold (no date range applied).  This is intentional:
 * floatPct = what fraction of every dollar ever sold is still sitting as
 * unspent balance, consumedPct = what fraction has been consumed over the
 * platform's lifetime.  Do not interpret these as period-scoped ratios.
 */
export interface FloatMetrics {
  /** Current total unspent credits across all tenants with balance > 0 */
  totalFloatCents: number;
  /** All-time total credits ever purchased (lifetime, not period-scoped) */
  totalCreditsSoldCents: number;
  /** Percentage of all-time credits sold that have been consumed (lifetime ratio) */
  consumedPct: number;
  /** Percentage of all-time credits sold still held as float (lifetime ratio) */
  floatPct: number;
  tenantCount: number;
}

export interface RevenueBreakdownRow {
  category: "per_use" | "monthly";
  capability: string;
  revenueCents: number;
}

export interface MarginByCapability {
  capability: string;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number;
}

export interface ProviderSpendRow {
  provider: string;
  callCount: number;
  spendCents: number;
  avgCostPerCallCents: number;
}

export interface TenantHealthSummary {
  totalTenants: number;
  activeTenants: number; // used within last 30 days
  withBalance: number; // balance > 0
  dormant: number; // no use in 30d
  atRisk: number; // low runway, no auto top-up (placeholder)
}

export interface AutoTopupMetrics {
  totalEvents: number;
  successCount: number;
  failedCount: number;
  revenueCents: number;
  failureRate: number;
}

export interface TimeSeriesPoint {
  periodStart: number; // unix epoch ms
  periodEnd: number; // unix epoch ms
  creditsSoldCents: number;
  revenueConsumedCents: number;
  providerCostCents: number;
  marginCents: number;
}

const MAX_TIME_SERIES_POINTS = 1000;

export class AnalyticsStore {
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private toIsoRange(range: DateRange): { from: string; to: string } {
    return {
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
    };
  }

  private toCsv(headers: string[], rows: Record<string, unknown>[]): string {
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(
        headers
          .map((h) => {
            const val = row[h];
            if (typeof val === "string" && /[",\r\n]/.test(val)) {
              return `"${val.replace(/"/g, '""')}"`;
            }
            return String(val ?? "");
          })
          .join(","),
      );
    }
    return lines.join("\n");
  }

  async getRevenueOverview(range: DateRange): Promise<RevenueOverview> {
    const iso = this.toIsoRange(range);

    const creditsSoldResult = await exec(
      this.db,
      sql`SELECT COALESCE(SUM(amount_credits), 0)::bigint as total
          FROM credit_transactions
          WHERE type = 'purchase' AND amount_credits > 0
            AND created_at >= ${iso.from} AND created_at <= ${iso.to}`,
    );

    const revenueConsumedResult = await exec(
      this.db,
      sql`SELECT COALESCE(SUM(ABS(amount_credits)), 0)::bigint as total
          FROM credit_transactions
          WHERE type IN ('bot_runtime', 'adapter_usage', 'addon')
            AND created_at >= ${iso.from} AND created_at <= ${iso.to}`,
    );

    const providerCostResult = await exec(
      this.db,
      sql`SELECT CAST(COALESCE(SUM(cost) * 100, 0) AS BIGINT) as total_cents
          FROM meter_events
          WHERE timestamp >= ${range.from} AND timestamp <= ${range.to}`,
    );

    const creditsSoldCents = Math.round(
      Number((creditsSoldResult.rows[0] as { total: string | number })?.total ?? 0) / 10_000_000,
    );
    const revenueConsumedCents = Math.round(
      Number((revenueConsumedResult.rows[0] as { total: string | number })?.total ?? 0) / 10_000_000,
    );
    const providerCostCents = Number(
      (providerCostResult.rows[0] as { total_cents: string | number })?.total_cents ?? 0,
    );
    const grossMarginCents = revenueConsumedCents - providerCostCents;
    const grossMarginPct = revenueConsumedCents > 0 ? (grossMarginCents / revenueConsumedCents) * 100 : 0;

    return {
      creditsSoldCents,
      revenueConsumedCents,
      providerCostCents,
      grossMarginCents,
      grossMarginPct,
    };
  }

  /**
   * Returns lifetime float metrics: current outstanding balance vs all-time
   * credits sold.  Neither figure is date-range-scoped; consumedPct/floatPct
   * are lifetime ratios, not period ratios.
   */
  async getFloat(): Promise<FloatMetrics> {
    const floatResult = await exec(
      this.db,
      sql`SELECT COUNT(*)::bigint as tenant_count, COALESCE(SUM(balance_credits), 0)::bigint as total_float
          FROM credit_balances
          WHERE balance_credits > 0`,
    );

    const soldResult = await exec(
      this.db,
      sql`SELECT COALESCE(SUM(amount_credits), 0)::bigint as total_sold
          FROM credit_transactions
          WHERE type = 'purchase' AND amount_credits > 0`,
    );

    const floatRow = floatResult.rows[0] as { tenant_count: string | number; total_float: string | number };
    const soldRow = soldResult.rows[0] as { total_sold: string | number };

    const totalFloatCents = Math.round(Number(floatRow?.total_float ?? 0) / 10_000_000);
    const totalCreditsSoldCents = Math.round(Number(soldRow?.total_sold ?? 0) / 10_000_000);
    const tenantCount = Number(floatRow?.tenant_count ?? 0);

    const floatPct = totalCreditsSoldCents > 0 ? (totalFloatCents / totalCreditsSoldCents) * 100 : 0;
    const consumedPct = 100 - floatPct;

    return {
      totalFloatCents,
      totalCreditsSoldCents,
      consumedPct,
      floatPct,
      tenantCount,
    };
  }

  async getRevenueBreakdown(range: DateRange): Promise<RevenueBreakdownRow[]> {
    const iso = this.toIsoRange(range);

    const perUseResult = await exec(
      this.db,
      sql`SELECT
            'per_use' as category,
            capability,
            CAST(COALESCE(SUM(charge) * 100, 0) AS BIGINT) as revenue_cents
          FROM meter_events
          WHERE timestamp >= ${range.from} AND timestamp <= ${range.to}
          GROUP BY capability
          ORDER BY revenue_cents DESC`,
    );

    const monthlyResult = await exec(
      this.db,
      sql`SELECT
            'monthly' as category,
            CASE
              WHEN type = 'bot_runtime' THEN 'agent_seat'
              WHEN type = 'addon' THEN 'addon'
              ELSE type
            END as capability,
            COALESCE(SUM(ABS(amount_credits)), 0)::bigint as revenue_cents
          FROM credit_transactions
          WHERE type IN ('bot_runtime', 'addon')
            AND created_at >= ${iso.from} AND created_at <= ${iso.to}
          GROUP BY capability
          ORDER BY revenue_cents DESC`,
    );

    const result: RevenueBreakdownRow[] = [];

    for (const row of perUseResult.rows as Array<{
      category: string;
      capability: string;
      revenue_cents: string | number;
    }>) {
      result.push({
        category: "per_use",
        capability: row.capability,
        revenueCents: Number(row.revenue_cents),
      });
    }

    for (const row of monthlyResult.rows as Array<{
      category: string;
      capability: string;
      revenue_cents: string | number;
    }>) {
      result.push({
        category: "monthly",
        capability: row.capability,
        revenueCents: Math.round(Number(row.revenue_cents) / 10_000_000),
      });
    }

    return result;
  }

  async getMarginByCapability(range: DateRange): Promise<MarginByCapability[]> {
    const result = await exec(
      this.db,
      sql`SELECT
            capability,
            CAST(COALESCE(SUM(charge) * 100, 0) AS BIGINT) as revenue_cents,
            CAST(COALESCE(SUM(cost) * 100, 0) AS BIGINT) as cost_cents
          FROM meter_events
          WHERE timestamp >= ${range.from} AND timestamp <= ${range.to}
          GROUP BY capability
          ORDER BY revenue_cents DESC`,
    );

    return (
      result.rows as Array<{ capability: string; revenue_cents: string | number; cost_cents: string | number }>
    ).map((row) => {
      const revenueCents = Number(row.revenue_cents);
      const costCents = Number(row.cost_cents);
      const marginCents = revenueCents - costCents;
      const marginPct = revenueCents > 0 ? (marginCents / revenueCents) * 100 : 0;
      return {
        capability: row.capability,
        revenueCents,
        costCents,
        marginCents,
        marginPct,
      };
    });
  }

  async getProviderSpend(range: DateRange): Promise<ProviderSpendRow[]> {
    const result = await exec(
      this.db,
      sql`SELECT
            provider,
            COUNT(*)::bigint as call_count,
            CAST(COALESCE(SUM(cost) * 100, 0) AS BIGINT) as spend_cents
          FROM meter_events
          WHERE timestamp >= ${range.from} AND timestamp <= ${range.to}
          GROUP BY provider
          ORDER BY spend_cents DESC`,
    );

    return (result.rows as Array<{ provider: string; call_count: string | number; spend_cents: string | number }>).map(
      (row) => {
        const callCount = Number(row.call_count);
        const spendCents = Number(row.spend_cents);
        return {
          provider: row.provider,
          callCount,
          spendCents,
          avgCostPerCallCents: callCount > 0 ? Math.round(spendCents / callCount) : 0,
        };
      },
    );
  }

  async getTenantHealth(): Promise<TenantHealthSummary> {
    const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totalResult = await exec(
      this.db,
      sql`SELECT COUNT(*)::bigint as total FROM (
            SELECT tenant_id FROM credit_balances
            UNION
            SELECT tenant_id FROM tenant_status
          ) t`,
    );

    const activeResult = await exec(
      this.db,
      sql`SELECT COUNT(DISTINCT tenant_id)::bigint as active
          FROM credit_transactions
          WHERE amount_credits < 0
            AND created_at >= ${thirtyDaysAgoIso}`,
    );

    const withBalanceResult = await exec(
      this.db,
      sql`SELECT COUNT(*)::bigint as with_balance
          FROM credit_balances
          WHERE balance_credits > 0`,
    );

    const atRiskResult = await exec(
      this.db,
      sql`SELECT COUNT(*)::bigint as at_risk
          FROM credit_balances
          WHERE balance_credits > 0 AND balance_credits < 5000000000
            AND tenant_id NOT IN (
              SELECT DISTINCT tenant_id FROM credit_auto_topup WHERE status = 'success'
            )`,
    );

    const totalTenants = Number((totalResult.rows[0] as { total: string | number })?.total ?? 0);
    const activeTenants = Number((activeResult.rows[0] as { active: string | number })?.active ?? 0);
    const withBalance = Number((withBalanceResult.rows[0] as { with_balance: string | number })?.with_balance ?? 0);
    const dormant = totalTenants - activeTenants;
    const atRisk = Number((atRiskResult.rows[0] as { at_risk: string | number })?.at_risk ?? 0);

    return {
      totalTenants,
      activeTenants,
      withBalance,
      dormant,
      atRisk,
    };
  }

  async getAutoTopupMetrics(range: DateRange): Promise<AutoTopupMetrics> {
    const iso = this.toIsoRange(range);

    const result = await exec(
      this.db,
      sql`SELECT
            COUNT(*)::bigint as total_events,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0)::bigint as success_count,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint as failed_count,
            COALESCE(SUM(CASE WHEN status = 'success' THEN amount_cents ELSE 0 END), 0)::bigint as revenue_cents
          FROM credit_auto_topup
          WHERE created_at >= ${iso.from} AND created_at <= ${iso.to}`,
    );

    const row = result.rows[0] as {
      total_events: string | number;
      success_count: string | number;
      failed_count: string | number;
      revenue_cents: string | number;
    };

    const totalEvents = Number(row?.total_events ?? 0);
    const failureRate = totalEvents > 0 ? (Number(row?.failed_count ?? 0) / totalEvents) * 100 : 0;

    return {
      totalEvents,
      successCount: Number(row?.success_count ?? 0),
      failedCount: Number(row?.failed_count ?? 0),
      revenueCents: Number(row?.revenue_cents ?? 0),
      failureRate,
    };
  }

  async getTimeSeries(range: DateRange, bucketMs: number): Promise<TimeSeriesPoint[]> {
    // Cap at MAX_TIME_SERIES_POINTS by auto-adjusting bucket size
    const rangeMs = range.to - range.from;
    const minBucketMs = Math.ceil(rangeMs / MAX_TIME_SERIES_POINTS);
    const effectiveBucketMs = Math.max(bucketMs, minBucketMs);

    const iso = this.toIsoRange(range);

    const meterResult = await exec(
      this.db,
      sql`SELECT
            (FLOOR(timestamp::numeric / ${effectiveBucketMs})::bigint * ${effectiveBucketMs}) as period_start,
            CAST(COALESCE(SUM(charge) * 100, 0) AS BIGINT) as per_use_revenue_cents,
            CAST(COALESCE(SUM(cost) * 100, 0) AS BIGINT) as provider_cost_cents
          FROM meter_events
          WHERE timestamp >= ${range.from} AND timestamp <= ${range.to}
          GROUP BY period_start
          ORDER BY period_start`,
    );

    const creditResult = await exec(
      this.db,
      sql`SELECT
            (FLOOR(EXTRACT(EPOCH FROM created_at::timestamptz) * 1000 / ${effectiveBucketMs})::bigint * ${effectiveBucketMs}) as period_start,
            COALESCE(SUM(CASE WHEN type = 'purchase' AND amount_credits > 0 THEN amount_credits ELSE 0 END), 0)::bigint as credits_sold_cents,
            COALESCE(SUM(CASE WHEN type IN ('bot_runtime', 'addon') THEN ABS(amount_credits) ELSE 0 END), 0)::bigint as monthly_revenue_cents
          FROM credit_transactions
          WHERE created_at >= ${iso.from} AND created_at <= ${iso.to}
          GROUP BY period_start
          ORDER BY period_start`,
    );

    // Merge by period_start
    const pointMap = new Map<number, TimeSeriesPoint>();

    for (const row of meterResult.rows as Array<{
      period_start: string | number;
      per_use_revenue_cents: string | number;
      provider_cost_cents: string | number;
    }>) {
      const ps = Number(row.period_start);
      pointMap.set(ps, {
        periodStart: ps,
        periodEnd: ps + effectiveBucketMs,
        creditsSoldCents: 0,
        revenueConsumedCents: Number(row.per_use_revenue_cents),
        providerCostCents: Number(row.provider_cost_cents),
        marginCents: Number(row.per_use_revenue_cents) - Number(row.provider_cost_cents),
      });
    }

    for (const row of creditResult.rows as Array<{
      period_start: string | number;
      credits_sold_cents: string | number;
      monthly_revenue_cents: string | number;
    }>) {
      const ps = Number(row.period_start);
      const existing = pointMap.get(ps);
      const creditsSold = Math.round(Number(row.credits_sold_cents) / 10_000_000);
      const monthlyRevenue = Math.round(Number(row.monthly_revenue_cents) / 10_000_000);
      if (existing) {
        existing.creditsSoldCents = creditsSold;
        existing.revenueConsumedCents += monthlyRevenue;
        existing.marginCents = existing.revenueConsumedCents - existing.providerCostCents;
      } else {
        pointMap.set(ps, {
          periodStart: ps,
          periodEnd: ps + effectiveBucketMs,
          creditsSoldCents: creditsSold,
          revenueConsumedCents: monthlyRevenue,
          providerCostCents: 0,
          marginCents: monthlyRevenue,
        });
      }
    }

    return Array.from(pointMap.values()).sort((a, b) => a.periodStart - b.periodStart);
  }

  async exportCsv(range: DateRange, section: string): Promise<string> {
    switch (section) {
      case "revenue_overview": {
        const overview = await this.getRevenueOverview(range);
        return this.toCsv(
          ["creditsSoldCents", "revenueConsumedCents", "providerCostCents", "grossMarginCents", "grossMarginPct"],
          [overview as unknown as Record<string, unknown>],
        );
      }
      case "revenue_breakdown": {
        const breakdown = await this.getRevenueBreakdown(range);
        return this.toCsv(
          ["category", "capability", "revenueCents"],
          breakdown as unknown as Record<string, unknown>[],
        );
      }
      case "margin_by_capability": {
        const margins = await this.getMarginByCapability(range);
        return this.toCsv(
          ["capability", "revenueCents", "costCents", "marginCents", "marginPct"],
          margins as unknown as Record<string, unknown>[],
        );
      }
      case "provider_spend": {
        const providers = await this.getProviderSpend(range);
        return this.toCsv(
          ["provider", "callCount", "spendCents", "avgCostPerCallCents"],
          providers as unknown as Record<string, unknown>[],
        );
      }
      case "tenant_health": {
        const health = await this.getTenantHealth();
        return this.toCsv(
          ["totalTenants", "activeTenants", "withBalance", "dormant", "atRisk"],
          [health as unknown as Record<string, unknown>],
        );
      }
      case "time_series": {
        const series = await this.getTimeSeries(range, 86_400_000);
        return this.toCsv(
          ["periodStart", "periodEnd", "creditsSoldCents", "revenueConsumedCents", "providerCostCents", "marginCents"],
          series as unknown as Record<string, unknown>[],
        );
      }
      case "auto_topup": {
        const metrics = await this.getAutoTopupMetrics(range);
        return this.toCsv(
          ["totalEvents", "successCount", "failedCount", "revenueCents", "failureRate"],
          [metrics as unknown as Record<string, unknown>],
        );
      }
      default:
        return "";
    }
  }
}
