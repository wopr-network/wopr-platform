import type { IAnalyticsRepository } from "./analytics-repository.js";

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
  private readonly repo: IAnalyticsRepository;

  constructor(repo: IAnalyticsRepository) {
    this.repo = repo;
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

    const creditsSoldRaw = await this.repo.sumCreditsPurchased(iso.from, iso.to);
    const revenueConsumedRaw = await this.repo.sumCreditsConsumed(iso.from, iso.to);
    const providerCostCents = await this.repo.sumProviderCostCents(range.from, range.to);

    const creditsSoldCents = Math.round(creditsSoldRaw / 10_000_000);
    const revenueConsumedCents = Math.round(revenueConsumedRaw / 10_000_000);
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
    const { tenantCount, totalFloatRaw } = await this.repo.getFloatBalances();
    const totalSoldRaw = await this.repo.sumAllTimeCreditsPurchased();

    const totalFloatCents = Math.round(totalFloatRaw / 10_000_000);
    const totalCreditsSoldCents = Math.round(totalSoldRaw / 10_000_000);

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

    const perUseRows = await this.repo.getPerUseRevenueBreakdown(range.from, range.to);
    const monthlyRows = await this.repo.getMonthlyRevenueBreakdown(iso.from, iso.to);

    const result: RevenueBreakdownRow[] = [];

    for (const row of perUseRows) {
      result.push({
        category: "per_use",
        capability: row.capability,
        revenueCents: row.revenueCents,
      });
    }

    for (const row of monthlyRows) {
      result.push({
        category: "monthly",
        capability: row.capability,
        revenueCents: Math.round(row.revenueCents / 10_000_000),
      });
    }

    return result;
  }

  async getMarginByCapability(range: DateRange): Promise<MarginByCapability[]> {
    const rows = await this.repo.getMarginByCapability(range.from, range.to);

    return rows.map((row) => {
      const revenueCents = row.revenueCents;
      const costCents = row.costCents;
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
    const rows = await this.repo.getProviderSpend(range.from, range.to);

    return rows.map((row) => {
      const callCount = row.callCount;
      const spendCents = row.spendCents;
      return {
        provider: row.provider,
        callCount,
        spendCents,
        avgCostPerCallCents: callCount > 0 ? Math.round(spendCents / callCount) : 0,
      };
    });
  }

  async getTenantHealth(): Promise<TenantHealthSummary> {
    const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totalTenants = await this.repo.countTotalTenants();
    const activeTenants = await this.repo.countActiveTenants(thirtyDaysAgoIso);
    const withBalance = await this.repo.countTenantsWithBalance();
    const atRisk = await this.repo.countAtRiskTenants();
    const dormant = totalTenants - activeTenants;

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
    const row = await this.repo.getAutoTopupMetrics(iso.from, iso.to);

    const totalEvents = row.totalEvents;
    const failureRate = totalEvents > 0 ? (row.failedCount / totalEvents) * 100 : 0;

    return {
      totalEvents,
      successCount: row.successCount,
      failedCount: row.failedCount,
      revenueCents: row.revenueCents,
      failureRate,
    };
  }

  async getTimeSeries(range: DateRange, bucketMs: number): Promise<TimeSeriesPoint[]> {
    // Cap at MAX_TIME_SERIES_POINTS by auto-adjusting bucket size
    const rangeMs = range.to - range.from;
    const minBucketMs = Math.ceil(rangeMs / MAX_TIME_SERIES_POINTS);
    const effectiveBucketMs = Math.max(bucketMs, minBucketMs);

    const iso = this.toIsoRange(range);

    const meterRows = await this.repo.getTimeSeriesMeter(range.from, range.to, effectiveBucketMs);
    const creditRows = await this.repo.getTimeSeriesCredits(iso.from, iso.to, effectiveBucketMs);

    // Merge by period_start
    const pointMap = new Map<number, TimeSeriesPoint>();

    for (const row of meterRows) {
      const ps = row.periodStart;
      pointMap.set(ps, {
        periodStart: ps,
        periodEnd: ps + effectiveBucketMs,
        creditsSoldCents: 0,
        revenueConsumedCents: row.perUseRevenueCents,
        providerCostCents: row.providerCostCents,
        marginCents: row.perUseRevenueCents - row.providerCostCents,
      });
    }

    for (const row of creditRows) {
      const ps = row.periodStart;
      const existing = pointMap.get(ps);
      const creditsSold = Math.round(row.creditsSoldRaw / 10_000_000);
      const monthlyRevenue = Math.round(row.monthlyRevenueRaw / 10_000_000);
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
