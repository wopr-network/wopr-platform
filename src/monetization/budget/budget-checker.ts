import { and, eq, gte, lte, sql } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { logger } from "../../config/logger.js";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import { Credit } from "../credit.js";

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
  maxPerHour: number | null;
  maxPerMonth: number | null;
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
    const cacheKey = tenant;
    let cached = this.cache.get(cacheKey);

    if (!cached) {
      // Cache miss -- query DB
      try {
        cached = await this.queryBudgetData(tenant, limits);
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
          maxSpendPerHour: null,
          maxSpendPerMonth: null,
        };
      }
    }

    // Check hourly limit first (more urgent)
    if (cached.maxPerHour !== null && cached.hourlySpend >= cached.maxPerHour) {
      return {
        allowed: false,
        reason: `Hourly spending limit exceeded: $${cached.hourlySpend.toFixed(2)}/$${cached.maxPerHour.toFixed(2)} (${label} tier). Upgrade your plan for higher limits.`,
        httpStatus: 429,
        currentHourlySpend: cached.hourlySpend,
        currentMonthlySpend: cached.monthlySpend,
        maxSpendPerHour: cached.maxPerHour,
        maxSpendPerMonth: cached.maxPerMonth,
      };
    }

    // Check monthly limit
    if (cached.maxPerMonth !== null && cached.monthlySpend >= cached.maxPerMonth) {
      return {
        allowed: false,
        reason: `Monthly spending limit exceeded: $${cached.monthlySpend.toFixed(2)}/$${cached.maxPerMonth.toFixed(2)} (${label} tier). Upgrade your plan for higher limits.`,
        httpStatus: 429,
        currentHourlySpend: cached.hourlySpend,
        currentMonthlySpend: cached.monthlySpend,
        maxSpendPerHour: cached.maxPerHour,
        maxSpendPerMonth: cached.maxPerMonth,
      };
    }

    return {
      allowed: true,
      currentHourlySpend: cached.hourlySpend,
      currentMonthlySpend: cached.monthlySpend,
      maxSpendPerHour: cached.maxPerHour,
      maxSpendPerMonth: cached.maxPerMonth,
    };
  }

  /**
   * Query current budget data from the DB.
   * Combines data from meter_events buffer + usage_summaries.
   */
  private async queryBudgetData(tenant: string, limits: SpendLimits): Promise<CachedBudgetData> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const monthStart = this.getMonthStart(now);

    // Query hourly spend from both meter_events (unbuffered) and usage_summaries (aggregated)
    const hourlyEvents = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
        })
        .from(meterEvents)
        .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, oneHourAgo)))
    )[0];

    const hourlySummaries = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
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

    const hourlySpend = Credit.fromRaw(
      Number(hourlyEvents?.total ?? 0) + Number(hourlySummaries?.total ?? 0),
    ).toDollars();

    // Query monthly spend
    const monthlyEvents = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
        })
        .from(meterEvents)
        .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, monthStart)))
    )[0];

    const monthlySummaries = (
      await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
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

    const monthlySpend = Credit.fromRaw(
      Number(monthlyEvents?.total ?? 0) + Number(monthlySummaries?.total ?? 0),
    ).toDollars();

    return {
      hourlySpend,
      monthlySpend,
      maxPerHour: limits.maxSpendPerHour,
      maxPerMonth: limits.maxSpendPerMonth,
    };
  }

  /**
   * Get the start of the current month (unix epoch ms).
   */
  private getMonthStart(now: number): number {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  }

  /**
   * Invalidate cache for a specific tenant (useful after spend updates).
   */
  invalidate(tenant: string): void {
    this.cache.delete(tenant);
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
