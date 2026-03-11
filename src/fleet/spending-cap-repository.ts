/**
 * Drizzle implementation of ISpendingCapStore.
 *
 * All Drizzle ORM imports are confined to this file.
 * Gateway business logic depends only on the ISpendingCapStore interface
 * defined in src/gateway/spending-cap-store.ts.
 */

import { Credit } from "@wopr-network/platform-core/credits";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { meterEvents, usageSummaries } from "../db/schema/meter-events.js";
import type { ISpendingCapStore, SpendingCapRecord } from "../gateway/spending-cap-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the start of the current UTC day in milliseconds. */
export function getDayStart(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Get the start of the current calendar month in milliseconds (UTC). */
export function getMonthStart(now: number): number {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).getTime();
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

/** Drizzle-backed implementation of ISpendingCapStore. */
export class DrizzleSpendingCapStore implements ISpendingCapStore {
  constructor(private readonly db: DrizzleDb) {}

  async querySpend(tenant: string, now: number): Promise<SpendingCapRecord> {
    const dayStart = getDayStart(now);
    const monthStart = getMonthStart(now);

    // --- Daily spend ---
    // 1. Sum usage_summaries in today's range, also capture the latest window_end
    const dailySummariesRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
        // raw SQL: Drizzle cannot express COALESCE(MAX(...), 0) natively
        latestEnd: sql<number>`COALESCE(MAX(${usageSummaries.windowEnd}), 0)`,
      })
      .from(usageSummaries)
      .where(
        and(
          eq(usageSummaries.tenant, tenant),
          gte(usageSummaries.windowEnd, dayStart),
          lte(usageSummaries.windowStart, now),
        ),
      );
    const dailySummaryTotal = Number(dailySummariesRows[0]?.total ?? 0);
    const dailyLatestEnd = Number(dailySummariesRows[0]?.latestEnd ?? 0);

    // 2. Only query meter_events newer than the latest summary window end
    //    (these haven't been rolled up yet). If no summaries, use dayStart.
    // Assumes contiguous summary windows — gap between windows could under-count spend
    // (acceptable limitation at current scale; aggregator guarantees gapless windows)
    const dailyEventsStart = dailyLatestEnd > dayStart ? dailyLatestEnd : dayStart;
    const dailyEventsRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
      })
      .from(meterEvents)
      .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, dailyEventsStart)));
    const dailyEventTotal = Number(dailyEventsRows[0]?.total ?? 0);

    const dailySpend = Credit.fromRaw(dailySummaryTotal + dailyEventTotal).toDollars();

    // --- Monthly spend ---
    const monthlySummariesRows = await this.db
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
      );
    const monthlySummaryTotal = Number(monthlySummariesRows[0]?.total ?? 0);
    const monthlyLatestEnd = Number(monthlySummariesRows[0]?.latestEnd ?? 0);

    // Assumes contiguous summary windows — gap between windows could under-count spend
    // (acceptable limitation at current scale; aggregator guarantees gapless windows)
    const monthlyEventsStart = monthlyLatestEnd > monthStart ? monthlyLatestEnd : monthStart;
    const monthlyEventsRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
      })
      .from(meterEvents)
      .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, monthlyEventsStart)));
    const monthlyEventTotal = Number(monthlyEventsRows[0]?.total ?? 0);

    const monthlySpend = Credit.fromRaw(monthlySummaryTotal + monthlyEventTotal).toDollars();

    return { dailySpend, monthlySpend };
  }
}
