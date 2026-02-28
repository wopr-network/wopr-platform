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
import { Credit } from "../monetization/credit.js";

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

    // Daily spend from meter_events
    const dailyEventsRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
      })
      .from(meterEvents)
      .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, dayStart)));
    const dailyEvents = dailyEventsRows[0];

    // Daily spend from usage_summaries (may overlap — conservative to sum both)
    const dailySummariesRows = await this.db
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
      );
    const dailySummaries = dailySummariesRows[0];

    const dailySpend = Credit.fromRaw(Number(dailyEvents?.total ?? 0) + Number(dailySummaries?.total ?? 0)).toDollars();

    // Monthly spend from meter_events
    const monthlyEventsRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${meterEvents.charge}), 0)`,
      })
      .from(meterEvents)
      .where(and(eq(meterEvents.tenant, tenant), gte(meterEvents.timestamp, monthStart)));
    const monthlyEvents = monthlyEventsRows[0];

    // Monthly spend from usage_summaries
    const monthlySummariesRows = await this.db
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
      );
    const monthlySummaries = monthlySummariesRows[0];

    const monthlySpend = Credit.fromRaw(
      Number(monthlyEvents?.total ?? 0) + Number(monthlySummaries?.total ?? 0),
    ).toDollars();

    return { dailySpend, monthlySpend };
  }
}
