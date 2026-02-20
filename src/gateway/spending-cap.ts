/**
 * Spending cap enforcement middleware for the API gateway.
 *
 * Before every capability request, queries the tenant's accumulated
 * daily and monthly spend from meter_events + usage_summaries and compares
 * against their configured caps. Rejects with 402 if over cap.
 *
 * Spending caps are user-configured hard stops, distinct from plan-level
 * spend limits enforced by BudgetChecker.
 *
 * Uses an LRU cache with short TTL to avoid DB queries on every request.
 * In-memory state is lost on server restart — acceptable for the current
 * single-server architecture.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler, Next } from "hono";
import { LRUCache } from "lru-cache";
import type { DrizzleDb } from "../db/index.js";
import { meterEvents, usageSummaries } from "../db/schema/meter-events.js";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpendingCapConfig {
  /** Cache TTL for spend queries in ms. Default 15_000 (15 seconds). */
  cacheTtlMs: number;
  /** Max cache entries. Default 1000. */
  cacheMaxSize: number;
}

export interface SpendingCaps {
  /** Daily spending cap in USD (null = no cap). */
  dailyCapUsd: number | null;
  /** Monthly spending cap in USD (null = no cap). */
  monthlyCapUsd: number | null;
}

const DEFAULT_CONFIG: SpendingCapConfig = {
  cacheTtlMs: 15_000,
  cacheMaxSize: 1000,
};

interface CachedSpend {
  dailySpend: number;
  monthlySpend: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the start of the current UTC day in milliseconds. */
function getDayStart(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Get the start of the current calendar month in milliseconds (local time, matching BudgetChecker). */
function getMonthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}

/** Query current daily and monthly spend for a tenant. */
function querySpend(db: DrizzleDb, tenant: string, now: number): CachedSpend {
  const dayStart = getDayStart(now);
  const monthStart = getMonthStart(now);

  // Daily spend from meter_events
  const dailyEvents = db
    .select({
      total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
    })
    .from(meterEvents)
    .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, dayStart)))
    .get();

  // Daily spend from usage_summaries (may overlap — conservative to sum both)
  const dailySummaries = db
    .select({
      total: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
    })
    .from(usageSummaries)
    .where(
      and(
        eq(usageSummaries.tenant, tenant),
        gte(usageSummaries.windowEnd, dayStart),
        lte(usageSummaries.windowStart, now),
      ),
    )
    .get();

  const dailySpend = (dailyEvents?.total ?? 0) + (dailySummaries?.total ?? 0);

  // Monthly spend from meter_events
  const monthlyEvents = db
    .select({
      total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
    })
    .from(meterEvents)
    .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, monthStart)))
    .get();

  // Monthly spend from usage_summaries
  const monthlySummaries = db
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
    .get();

  const monthlySpend = (monthlyEvents?.total ?? 0) + (monthlySummaries?.total ?? 0);

  return { dailySpend, monthlySpend };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create spending cap enforcement middleware.
 *
 * Before every capability request, checks the tenant's configured spending
 * caps (from GatewayTenant.spendingCaps). Rejects with 402 if over cap.
 * Uses LRU cache with short TTL to avoid DB queries on every request.
 */
export function spendingCapCheck(db: DrizzleDb, config?: Partial<SpendingCapConfig>): MiddlewareHandler {
  const cfg: SpendingCapConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const cache = new LRUCache<string, CachedSpend>({
    max: cfg.cacheMaxSize,
    ttl: cfg.cacheTtlMs,
  });

  return async (c: Context, next: Next) => {
    const tenant = c.get("gatewayTenant") as GatewayTenant | undefined;
    if (!tenant) return next();

    const caps = tenant.spendingCaps;

    // No caps configured or both null — no enforcement needed
    if (!caps || (caps.dailyCapUsd === null && caps.monthlyCapUsd === null)) {
      return next();
    }

    const now = Date.now();
    let spend = cache.get(tenant.id);

    if (!spend) {
      spend = querySpend(db, tenant.id, now);
      cache.set(tenant.id, spend);
    }

    // Check daily cap first (more urgent, shorter period)
    if (caps.dailyCapUsd !== null && spend.dailySpend >= caps.dailyCapUsd) {
      return c.json(
        {
          error: {
            message: `Daily spending cap exceeded: $${spend.dailySpend.toFixed(2)}/$${caps.dailyCapUsd.toFixed(2)}. Adjust your cap in settings to continue.`,
            type: "billing_error",
            code: "spending_cap_exceeded",
            cap_type: "daily",
            current_spend_usd: spend.dailySpend,
            cap_usd: caps.dailyCapUsd,
            settings_url: "/dashboard/settings",
          },
        },
        402,
      );
    }

    // Check monthly cap
    if (caps.monthlyCapUsd !== null && spend.monthlySpend >= caps.monthlyCapUsd) {
      return c.json(
        {
          error: {
            message: `Monthly spending cap exceeded: $${spend.monthlySpend.toFixed(2)}/$${caps.monthlyCapUsd.toFixed(2)}. Adjust your cap in settings to continue.`,
            type: "billing_error",
            code: "spending_cap_exceeded",
            cap_type: "monthly",
            current_spend_usd: spend.monthlySpend,
            cap_usd: caps.monthlyCapUsd,
            settings_url: "/dashboard/settings",
          },
        },
        402,
      );
    }

    return next();
  };
}
