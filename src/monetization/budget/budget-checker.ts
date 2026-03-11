import { Credit } from "@wopr-network/platform-core/credits";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { logger } from "../../config/logger.js";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";

/**
 * Spend limits passed by callers (replaces dead TierStore/SpendOverrideStore).
 */
export interface SpendLimits {
  /** Hourly spending limit in USD (null = unlimited) */
  maxSpendPerHour: number | null;
  /** Monthly spending limit in USD (null = unlimited) */
  maxSpendPerMonth: number | null;
  /** Human-readable label for error messages */
  label?: string;
}

/**
 * Result of a pre-call budget check.
 */
export interface BudgetCheckResult {
  allowed: boolean;
  /** If not allowed, the reason */
  reason?: string;
  /** HTTP status to return (429 = Too Many Requests) */
  httpStatus?: number;
  /** Current hourly spend */
  currentHourlySpend: number;
  /** Current monthly spend */
  currentMonthlySpend: number;
  /** Hourly limit (null = unlimited) */
  maxSpendPerHour: number | null;
  /** Monthly limit (null = unlimited) */
  maxSpendPerMonth: number | null;
}

/**
 * Configuration for the budget checker.
 */
export interface BudgetCheckerConfig {
  /** Cache TTL in milliseconds (default: 30000ms = 30s) */
  cacheTtlMs?: number;
  /** Maximum cache size (default: 1000 entries) */
  cacheMaxSize?: number;
}

interface CachedBudgetData {
  hourlySpend: number;
  monthlySpend: number;
}

export interface IBudgetChecker {
  check(tenant: string, limits: SpendLimits): Promise<BudgetCheckResult>;
  invalidate(tenant: string): void;
  clearCache(): void;
}

/**
 * Pre-call budget checker with in-memory LRU cache.
 *
 * Before every upstream API call, this middleware queries the tenant's
 * accumulated spend from meter_events + usage_summaries and compares it
 * against caller-provided spend limits. If the budget is exceeded, the
 * call is rejected with HTTP 429.
 *
 * Design:
 * - Uses an in-memory LRU cache with ~30s TTL to avoid DB queries on every request
 * - Fail-closed: if DB is unavailable or cache miss fails, reject the call
 * - Callers pass SpendLimits directly (no more TierStore dependency)
 */
export class DrizzleBudgetChecker implements IBudgetChecker {
  private readonly cache: LRUCache<string, CachedBudgetData>;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly db: DrizzleDb,
    config: BudgetCheckerConfig = {},
  ) {
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000; // 30 seconds default

    this.cache = new LRUCache<string, CachedBudgetData>({
      max: config.cacheMaxSize ?? 1000,
      ttl: this.cacheTtlMs,
    });
  }

  /**
   * Check if a tenant can make an API call given their current spend.
   *
   * @param tenant - Tenant identifier
   * @param limits - Spend limits for this tenant
   * @returns BudgetCheckResult indicating whether the call is allowed
   */
  async check(tenant: string, limits: SpendLimits): Promise<BudgetCheckResult> {
    const label = limits.label ?? "current";

    // Try to get cached data
    // Include time buckets in the key so cached spend never leaks across billing periods.
    const hourlyBucket = Math.floor(Date.now() / 3600_000);
    const monthlyBucket = new Date().toISOString().slice(0, 7); // YYYY-MM
    const cacheKey = `${tenant}:${hourlyBucket}:${monthlyBucket}`;
    let cached = this.cache.get(cacheKey);

    if (!cached) {
      // Cache miss -- query DB
      try {
        cached = await this.queryBudgetData(tenant);
        this.cache.set(cacheKey, cached);
      } catch (err) {
        logger.error("Budget check query failed", { tenant, error: err });
        // Fail-closed: if DB query fails, reject the call
        return {
          allowed: false,
          reason: "Budget check unavailable. Please try again later.",
          httpStatus: 503,
          currentHourlySpend: 0,
          currentMonthlySpend: 0,
          maxSpendPerHour: limits.maxSpendPerHour,
          maxSpendPerMonth: limits.maxSpendPerMonth,
        };
      }
    }

    // Check hourly limit first (more urgent)
    if (limits.maxSpendPerHour !== null && cached.hourlySpend >= limits.maxSpendPerHour) {
      return {
        allowed: false,
        reason: `Hourly spending limit exceeded: $${cached.hourlySpend.toFixed(2)}/$${limits.maxSpendPerHour.toFixed(2)} (${label} tier). Upgrade your plan for higher limits.`,
        httpStatus: 429,
        currentHourlySpend: cached.hourlySpend,
        currentMonthlySpend: cached.monthlySpend,
        maxSpendPerHour: limits.maxSpendPerHour,
        maxSpendPerMonth: limits.maxSpendPerMonth,
      };
    }

    // Check monthly limit
    if (limits.maxSpendPerMonth !== null && cached.monthlySpend >= limits.maxSpendPerMonth) {
      return {
        allowed: false,
        reason: `Monthly spending limit exceeded: $${cached.monthlySpend.toFixed(2)}/$${limits.maxSpendPerMonth.toFixed(2)} (${label} tier). Upgrade your plan for higher limits.`,
        httpStatus: 429,
        currentHourlySpend: cached.hourlySpend,
        currentMonthlySpend: cached.monthlySpend,
        maxSpendPerHour: limits.maxSpendPerHour,
        maxSpendPerMonth: limits.maxSpendPerMonth,
      };
    }

    return {
      allowed: true,
      currentHourlySpend: cached.hourlySpend,
      currentMonthlySpend: cached.monthlySpend,
      maxSpendPerHour: limits.maxSpendPerHour,
      maxSpendPerMonth: limits.maxSpendPerMonth,
    };
  }

  /**
   * Query current budget data from the DB.
   * Combines data from meter_events buffer + usage_summaries.
   */
  private async queryBudgetData(tenant: string): Promise<CachedBudgetData> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const monthStart = this.getMonthStart(now);

    // --- Hourly spend ---
    // 1. Sum usage_summaries + find latest window_end
    const hourlySummaries = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
          // raw SQL: Drizzle cannot express COALESCE(MAX(...), 0) natively
          latestEnd: sql<number>`COALESCE(MAX(${usageSummaries.windowEnd}), 0)`,
        })
        .from(usageSummaries)
        .where(
          and(
            eq(usageSummaries.tenant, tenant),
            gte(usageSummaries.windowEnd, oneHourAgo),
            lte(usageSummaries.windowStart, now),
          ),
        )
    )[0];
    const hourlySummaryTotal = Number(hourlySummaries?.total ?? 0);
    const hourlyLatestEnd = Number(hourlySummaries?.latestEnd ?? 0);

    // 2. Only query meter_events newer than the latest summary window end
    // Assumes contiguous summary windows — gap between windows could under-count spend
    // (acceptable limitation at current scale; aggregator guarantees gapless windows)
    const hourlyEventsStart = hourlyLatestEnd > oneHourAgo ? hourlyLatestEnd : oneHourAgo;
    const hourlyEvents = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
        })
        .from(meterEvents)
        .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, hourlyEventsStart)))
    )[0];
    const hourlyEventTotal = Number(hourlyEvents?.total ?? 0);

    const hourlySpend = Credit.fromRaw(hourlySummaryTotal + hourlyEventTotal).toDollars();

    // --- Monthly spend ---
    const monthlySummaries = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
          // raw SQL: Drizzle cannot express COALESCE(MAX(...), 0) natively
          latestEnd: sql<number>`COALESCE(MAX(${usageSummaries.windowEnd}), 0)`,
        })
        .from(usageSummaries)
        .where(
          and(
            eq(usageSummaries.tenant, tenant),
            gte(usageSummaries.windowEnd, monthStart),
            lte(usageSummaries.windowStart, now),
          ),
        )
    )[0];
    const monthlySummaryTotal = Number(monthlySummaries?.total ?? 0);
    const monthlyLatestEnd = Number(monthlySummaries?.latestEnd ?? 0);

    // Assumes contiguous summary windows — gap between windows could under-count spend
    // (acceptable limitation at current scale; aggregator guarantees gapless windows)
    const monthlyEventsStart = monthlyLatestEnd > monthStart ? monthlyLatestEnd : monthStart;
    const monthlyEvents = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
        })
        .from(meterEvents)
        .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, monthlyEventsStart)))
    )[0];
    const monthlyEventTotal = Number(monthlyEvents?.total ?? 0);

    const monthlySpend = Credit.fromRaw(monthlySummaryTotal + monthlyEventTotal).toDollars();

    return {
      hourlySpend,
      monthlySpend,
    };
  }

  /**
   * Get the start of the current month (unix epoch ms).
   */
  private getMonthStart(now: number): number {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).getTime();
  }

  /**
   * Invalidate cache for a specific tenant (useful after spend updates).
   */
  invalidate(tenant: string): void {
    const prefix = `${tenant}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// Backward-compat alias.
export { DrizzleBudgetChecker as BudgetChecker };
