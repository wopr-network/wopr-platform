import type Database from "better-sqlite3";
import { LRUCache } from "lru-cache";
import type { PlanTier } from "../quotas/tier-definitions.js";
import { SpendOverrideStore, TierStore } from "../quotas/tier-definitions.js";

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

/**
 * Pre-call budget checker with in-memory LRU cache.
 *
 * Before every upstream API call, this middleware queries the tenant's
 * accumulated spend from meter_events + usage_summaries and compares it
 * against tier limits. If the budget is exceeded, the call is rejected
 * with HTTP 429.
 *
 * Design:
 * - Uses an in-memory LRU cache with ~30s TTL to avoid DB queries on every request
 * - Fail-closed: if DB is unavailable or cache miss fails, reject the call
 * - Supports per-tenant spend overrides (takes precedence over tier defaults)
 */
export class BudgetChecker {
  private readonly cache: LRUCache<string, CachedBudgetData>;
  private readonly cacheTtlMs: number;
  private readonly tierStore: TierStore;
  private readonly overrideStore: SpendOverrideStore;

  constructor(
    private readonly db: Database.Database,
    config: BudgetCheckerConfig = {},
  ) {
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000; // 30 seconds default
    this.tierStore = new TierStore(db);
    this.overrideStore = new SpendOverrideStore(db);

    this.cache = new LRUCache<string, CachedBudgetData>({
      max: config.cacheMaxSize ?? 1000,
      ttl: this.cacheTtlMs,
    });
  }

  /**
   * Check if a tenant can make an API call given their current spend.
   *
   * @param tenant - Tenant identifier
   * @param tier - The tenant's plan tier (or tier ID string)
   * @returns BudgetCheckResult indicating whether the call is allowed
   */
  check(tenant: string, tier: PlanTier | string): BudgetCheckResult {
    // Resolve tier if passed as string
    const resolvedTier = typeof tier === "string" ? this.tierStore.get(tier) : tier;
    if (!resolvedTier) {
      // Fail-closed: if we can't find the tier, reject the call
      return {
        allowed: false,
        reason: "Unable to verify tier configuration. Please contact support.",
        httpStatus: 500,
        currentHourlySpend: 0,
        currentMonthlySpend: 0,
        maxSpendPerHour: null,
        maxSpendPerMonth: null,
      };
    }

    // Try to get cached data
    const cacheKey = `${tenant}`;
    let cached = this.cache.get(cacheKey);

    if (!cached) {
      // Cache miss — query DB
      try {
        cached = this.queryBudgetData(tenant, resolvedTier);
        this.cache.set(cacheKey, cached);
      } catch (_err) {
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
        reason: `Hourly spending limit exceeded: $${cached.hourlySpend.toFixed(2)}/$${cached.maxPerHour.toFixed(2)} (${resolvedTier.name} tier). Upgrade your plan for higher limits.`,
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
        reason: `Monthly spending limit exceeded: $${cached.monthlySpend.toFixed(2)}/$${cached.maxPerMonth.toFixed(2)} (${resolvedTier.name} tier). Upgrade your plan for higher limits.`,
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
  private queryBudgetData(tenant: string, tier: PlanTier): CachedBudgetData {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const monthStart = this.getMonthStart(now);

    // Query hourly spend from both meter_events (unbuffered) and usage_summaries (aggregated)
    const hourlyEvents = this.db
      .prepare(
        `SELECT COALESCE(SUM(charge), 0) as total
         FROM meter_events
         WHERE tenant = ? AND timestamp >= ?`,
      )
      .get(tenant, oneHourAgo) as { total: number };

    const hourlySummaries = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_charge), 0) as total
         FROM usage_summaries
         WHERE tenant = ? AND window_start >= ?`,
      )
      .get(tenant, oneHourAgo) as { total: number };

    const hourlySpend = hourlyEvents.total + hourlySummaries.total;

    // Query monthly spend
    const monthlyEvents = this.db
      .prepare(
        `SELECT COALESCE(SUM(charge), 0) as total
         FROM meter_events
         WHERE tenant = ? AND timestamp >= ?`,
      )
      .get(tenant, monthStart) as { total: number };

    const monthlySummaries = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_charge), 0) as total
         FROM usage_summaries
         WHERE tenant = ? AND window_start >= ?`,
      )
      .get(tenant, monthStart) as { total: number };

    const monthlySpend = monthlyEvents.total + monthlySummaries.total;

    // Get per-tenant overrides (takes precedence over tier defaults)
    const override = this.overrideStore.get(tenant);
    const maxPerHour = override?.maxSpendPerHour ?? tier.maxSpendPerHour ?? null;
    const maxPerMonth = override?.maxSpendPerMonth ?? tier.maxSpendPerMonth ?? null;

    return {
      hourlySpend,
      monthlySpend,
      maxPerHour,
      maxPerMonth,
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
    this.cache.delete(`${tenant}`);
  }

  /**
   * Clear the entire cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}
