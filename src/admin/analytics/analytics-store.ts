import type Database from "better-sqlite3";
import type { DrizzleDb } from "../../db/index.js";

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
  private readonly sqlite: Database.Database;

  constructor(db: DrizzleDb) {
    // raw SQL: Drizzle cannot express the complex aggregations, multi-table UNIONs,
    // integer epoch bucketing arithmetic, and CASE-based pivot queries used throughout
    // this analytics store
    this.sqlite = db.$client;
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

  getRevenueOverview(range: DateRange): RevenueOverview {
    const iso = this.toIsoRange(range);

    const creditsSoldRow = this.sqlite
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total
         FROM credit_transactions
         WHERE type = 'purchase' AND amount_cents > 0
           AND created_at >= ? AND created_at <= ?`,
      )
      .get(iso.from, iso.to) as { total: number };

    const revenueConsumedRow = this.sqlite
      .prepare(
        `SELECT COALESCE(SUM(ABS(amount_cents)), 0) as total
         FROM credit_transactions
         WHERE type IN ('bot_runtime', 'adapter_usage', 'addon')
           AND created_at >= ? AND created_at <= ?`,
      )
      .get(iso.from, iso.to) as { total: number };

    const providerCostRow = this.sqlite
      .prepare(
        `SELECT COALESCE(CAST(SUM(cost) * 100 AS INTEGER), 0) as total_cents
         FROM meter_events
         WHERE timestamp >= ? AND timestamp <= ?`,
      )
      .get(range.from, range.to) as { total_cents: number };

    const creditsSoldCents = creditsSoldRow.total;
    const revenueConsumedCents = revenueConsumedRow.total;
    const providerCostCents = providerCostRow.total_cents;
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
  getFloat(): FloatMetrics {
    const floatRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) as tenant_count, COALESCE(SUM(balance_cents), 0) as total_float
         FROM credit_balances
         WHERE balance_cents > 0`,
      )
      .get() as { tenant_count: number; total_float: number };

    const soldRow = this.sqlite
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total_sold
         FROM credit_transactions
         WHERE type = 'purchase' AND amount_cents > 0`,
      )
      .get() as { total_sold: number };

    const totalFloatCents = floatRow.total_float;
    const totalCreditsSoldCents = soldRow.total_sold;
    const tenantCount = floatRow.tenant_count;

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

  getRevenueBreakdown(range: DateRange): RevenueBreakdownRow[] {
    const iso = this.toIsoRange(range);

    const perUseRows = this.sqlite
      .prepare(
        `SELECT
           'per_use' as category,
           capability,
           CAST(COALESCE(SUM(charge) * 100, 0) AS INTEGER) as revenue_cents
         FROM meter_events
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY capability
         ORDER BY revenue_cents DESC`,
      )
      .all(range.from, range.to) as Array<{
      category: string;
      capability: string;
      revenue_cents: number;
    }>;

    const monthlyRows = this.sqlite
      .prepare(
        `SELECT
           'monthly' as category,
           CASE
             WHEN type = 'bot_runtime' THEN 'agent_seat'
             WHEN type = 'addon' THEN 'addon'
             ELSE type
           END as capability,
           COALESCE(SUM(ABS(amount_cents)), 0) as revenue_cents
         FROM credit_transactions
         WHERE type IN ('bot_runtime', 'addon')
           AND created_at >= ? AND created_at <= ?
         GROUP BY capability
         ORDER BY revenue_cents DESC`,
      )
      .all(iso.from, iso.to) as Array<{
      category: string;
      capability: string;
      revenue_cents: number;
    }>;

    const result: RevenueBreakdownRow[] = [];

    for (const row of perUseRows) {
      result.push({
        category: "per_use",
        capability: row.capability,
        revenueCents: row.revenue_cents,
      });
    }

    for (const row of monthlyRows) {
      result.push({
        category: "monthly",
        capability: row.capability,
        revenueCents: row.revenue_cents,
      });
    }

    return result;
  }

  getMarginByCapability(range: DateRange): MarginByCapability[] {
    const rows = this.sqlite
      .prepare(
        `SELECT
           capability,
           CAST(COALESCE(SUM(charge) * 100, 0) AS INTEGER) as revenue_cents,
           CAST(COALESCE(SUM(cost) * 100, 0) AS INTEGER) as cost_cents
         FROM meter_events
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY capability
         ORDER BY revenue_cents DESC`,
      )
      .all(range.from, range.to) as Array<{
      capability: string;
      revenue_cents: number;
      cost_cents: number;
    }>;

    return rows.map((row) => {
      const marginCents = row.revenue_cents - row.cost_cents;
      const marginPct = row.revenue_cents > 0 ? (marginCents / row.revenue_cents) * 100 : 0;
      return {
        capability: row.capability,
        revenueCents: row.revenue_cents,
        costCents: row.cost_cents,
        marginCents,
        marginPct,
      };
    });
  }

  getProviderSpend(range: DateRange): ProviderSpendRow[] {
    const rows = this.sqlite
      .prepare(
        `SELECT
           provider,
           COUNT(*) as call_count,
           CAST(COALESCE(SUM(cost) * 100, 0) AS INTEGER) as spend_cents
         FROM meter_events
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY provider
         ORDER BY spend_cents DESC`,
      )
      .all(range.from, range.to) as Array<{
      provider: string;
      call_count: number;
      spend_cents: number;
    }>;

    return rows.map((row) => ({
      provider: row.provider,
      callCount: row.call_count,
      spendCents: row.spend_cents,
      avgCostPerCallCents: row.call_count > 0 ? Math.round(row.spend_cents / row.call_count) : 0,
    }));
  }

  getTenantHealth(): TenantHealthSummary {
    const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totalRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) as total FROM (
           SELECT tenant_id FROM credit_balances
           UNION
           SELECT tenant_id FROM tenant_status
         )`,
      )
      .get() as { total: number };

    const activeRow = this.sqlite
      .prepare(
        `SELECT COUNT(DISTINCT tenant_id) as active
         FROM credit_transactions
         WHERE amount_cents < 0
           AND created_at >= ?`,
      )
      .get(thirtyDaysAgoIso) as { active: number };

    const withBalanceRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) as with_balance
         FROM credit_balances
         WHERE balance_cents > 0`,
      )
      .get() as { with_balance: number };

    const totalTenants = totalRow.total;
    const activeTenants = activeRow.active;
    const withBalance = withBalanceRow.with_balance;
    const dormant = totalTenants - activeTenants;

    const atRiskRow = this.sqlite
      .prepare(
        `SELECT COUNT(*) as at_risk
         FROM credit_balances
         WHERE balance_cents > 0 AND balance_cents < 500
           AND tenant_id NOT IN (
             SELECT DISTINCT tenant_id FROM credit_auto_topup WHERE status = 'success'
           )`,
      )
      .get() as { at_risk: number };

    const atRisk = atRiskRow.at_risk;

    return {
      totalTenants,
      activeTenants,
      withBalance,
      dormant,
      atRisk,
    };
  }

  getAutoTopupMetrics(range: DateRange): AutoTopupMetrics {
    const iso = this.toIsoRange(range);

    const row = this.sqlite
      .prepare(
        `SELECT
           COUNT(*) as total_events,
           COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed_count,
           COALESCE(SUM(CASE WHEN status = 'success' THEN amount_cents ELSE 0 END), 0) as revenue_cents
         FROM credit_auto_topup
         WHERE created_at >= ? AND created_at <= ?`,
      )
      .get(iso.from, iso.to) as {
      total_events: number;
      success_count: number;
      failed_count: number;
      revenue_cents: number;
    };

    const totalEvents = row.total_events;
    const failureRate = totalEvents > 0 ? (row.failed_count / totalEvents) * 100 : 0;

    return {
      totalEvents,
      successCount: row.success_count,
      failedCount: row.failed_count,
      revenueCents: row.revenue_cents,
      failureRate,
    };
  }

  getTimeSeries(range: DateRange, bucketMs: number): TimeSeriesPoint[] {
    // Cap at MAX_TIME_SERIES_POINTS by auto-adjusting bucket size
    const rangeMs = range.to - range.from;
    const minBucketMs = Math.ceil(rangeMs / MAX_TIME_SERIES_POINTS);
    const effectiveBucketMs = Math.max(bucketMs, minBucketMs);

    const meterRows = this.sqlite
      .prepare(
        `SELECT
           (CAST(timestamp / ? AS INTEGER) * ?) as period_start,
           CAST(COALESCE(SUM(charge) * 100, 0) AS INTEGER) as per_use_revenue_cents,
           CAST(COALESCE(SUM(cost) * 100, 0) AS INTEGER) as provider_cost_cents
         FROM meter_events
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY period_start
         ORDER BY period_start`,
      )
      .all(effectiveBucketMs, effectiveBucketMs, range.from, range.to) as Array<{
      period_start: number;
      per_use_revenue_cents: number;
      provider_cost_cents: number;
    }>;

    const iso = this.toIsoRange(range);
    const creditRows = this.sqlite
      .prepare(
        `SELECT
           (CAST(CAST(strftime('%s', created_at) AS INTEGER) * 1000 / ? AS INTEGER) * ?) as period_start,
           COALESCE(SUM(CASE WHEN type = 'purchase' AND amount_cents > 0 THEN amount_cents ELSE 0 END), 0) as credits_sold_cents,
           COALESCE(SUM(CASE WHEN type IN ('bot_runtime', 'addon') THEN ABS(amount_cents) ELSE 0 END), 0) as monthly_revenue_cents
         FROM credit_transactions
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY period_start
         ORDER BY period_start`,
      )
      .all(effectiveBucketMs, effectiveBucketMs, iso.from, iso.to) as Array<{
      period_start: number;
      credits_sold_cents: number;
      monthly_revenue_cents: number;
    }>;

    // Merge by period_start
    const pointMap = new Map<number, TimeSeriesPoint>();

    for (const row of meterRows) {
      const ps = row.period_start;
      pointMap.set(ps, {
        periodStart: ps,
        periodEnd: ps + effectiveBucketMs,
        creditsSoldCents: 0,
        revenueConsumedCents: row.per_use_revenue_cents,
        providerCostCents: row.provider_cost_cents,
        marginCents: row.per_use_revenue_cents - row.provider_cost_cents,
      });
    }

    for (const row of creditRows) {
      const ps = row.period_start;
      const existing = pointMap.get(ps);
      if (existing) {
        existing.creditsSoldCents = row.credits_sold_cents;
        existing.revenueConsumedCents += row.monthly_revenue_cents;
        existing.marginCents = existing.revenueConsumedCents - existing.providerCostCents;
      } else {
        pointMap.set(ps, {
          periodStart: ps,
          periodEnd: ps + effectiveBucketMs,
          creditsSoldCents: row.credits_sold_cents,
          revenueConsumedCents: row.monthly_revenue_cents,
          providerCostCents: 0,
          marginCents: row.monthly_revenue_cents,
        });
      }
    }

    return Array.from(pointMap.values()).sort((a, b) => a.periodStart - b.periodStart);
  }

  exportCsv(range: DateRange, section: string): string {
    switch (section) {
      case "revenue_overview": {
        const overview = this.getRevenueOverview(range);
        return this.toCsv(
          ["creditsSoldCents", "revenueConsumedCents", "providerCostCents", "grossMarginCents", "grossMarginPct"],
          [overview as unknown as Record<string, unknown>],
        );
      }
      case "revenue_breakdown": {
        const breakdown = this.getRevenueBreakdown(range);
        return this.toCsv(
          ["category", "capability", "revenueCents"],
          breakdown as unknown as Record<string, unknown>[],
        );
      }
      case "margin_by_capability": {
        const margins = this.getMarginByCapability(range);
        return this.toCsv(
          ["capability", "revenueCents", "costCents", "marginCents", "marginPct"],
          margins as unknown as Record<string, unknown>[],
        );
      }
      case "provider_spend": {
        const providers = this.getProviderSpend(range);
        return this.toCsv(
          ["provider", "callCount", "spendCents", "avgCostPerCallCents"],
          providers as unknown as Record<string, unknown>[],
        );
      }
      case "tenant_health": {
        const health = this.getTenantHealth();
        return this.toCsv(
          ["totalTenants", "activeTenants", "withBalance", "dormant", "atRisk"],
          [health as unknown as Record<string, unknown>],
        );
      }
      case "time_series": {
        const series = this.getTimeSeries(range, 86_400_000);
        return this.toCsv(
          ["periodStart", "periodEnd", "creditsSoldCents", "revenueConsumedCents", "providerCostCents", "marginCents"],
          series as unknown as Record<string, unknown>[],
        );
      }
      case "auto_topup": {
        const metrics = this.getAutoTopupMetrics(range);
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
