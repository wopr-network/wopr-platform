/**
 * Drizzle implementation of ISpendingCapStore.
 *
 * All Drizzle ORM imports are confined to this file.
 * Gateway business logic depends only on the ISpendingCapStore interface
 * defined in src/gateway/spending-cap-store.ts.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { meterEvents, usageSummaries } from "../db/schema/meter-events.js";
import type { ISpendingCapStore, SpendingCapRecord } from "../gateway/spending-cap-store.js";

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

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

/** Drizzle-backed implementation of ISpendingCapStore. */
export class DrizzleSpendingCapStore implements ISpendingCapStore {
  constructor(private readonly db: DrizzleDb) {}

  querySpend(tenant: string, now: number): SpendingCapRecord {
    const dayStart = getDayStart(now);
    const monthStart = getMonthStart(now);

    // Daily spend from meter_events
    const dailyEvents = this.db
      .select({
        total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
      })
      .from(meterEvents)
      .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, dayStart)))
      .get();

    // Daily spend from usage_summaries (may overlap — conservative to sum both)
    const dailySummaries = this.db
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
    const monthlyEvents = this.db
      .select({
        total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
      })
      .from(meterEvents)
      .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, monthStart)))
      .get();

    // Monthly spend from usage_summaries
    const monthlySummaries = this.db
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
}
