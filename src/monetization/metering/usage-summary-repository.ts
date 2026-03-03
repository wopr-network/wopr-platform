import { and, count, desc, eq, gte, lt, lte, max, min, sql, sum } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import type { UsageSummary } from "./types.js";

export interface AggregatedWindowRow {
  tenant: string;
  capability: string;
  provider: string;
  eventCount: number;
  totalCost: number;
  totalCharge: number;
  totalDuration: number;
}

export interface UsageSummaryInsert {
  id: string;
  tenant: string;
  capability: string;
  provider: string;
  eventCount: number;
  totalCost: number;
  totalCharge: number;
  totalDuration: number;
  windowStart: number;
  windowEnd: number;
}

export interface IUsageSummaryRepository {
  /** Get the maximum windowEnd across all usage summaries. Returns 0 if none. */
  getLastWindowEnd(): Promise<number>;

  /** Get the earliest meter event timestamp before the given time. Returns null if none. */
  getEarliestEventTimestamp(before: number): Promise<number | null>;

  /** Get aggregated event groups for a time window [start, end). */
  getAggregatedEvents(windowStart: number, windowEnd: number): Promise<AggregatedWindowRow[]>;

  /** Insert a single usage summary row. */
  insertSummary(values: UsageSummaryInsert): Promise<void>;

  /** Insert multiple usage summary rows in a transaction. */
  insertSummariesBatch(rows: UsageSummaryInsert[]): Promise<void>;

  /** Query usage summaries for a tenant within a time range. */
  querySummaries(tenant: string, opts?: { since?: number; until?: number; limit?: number }): Promise<UsageSummary[]>;

  /** Get a tenant's total usage since a given time. */
  getTenantTotal(
    tenant: string,
    since: number,
  ): Promise<{ totalCost: number; totalCharge: number; eventCount: number }>;
}

export class DrizzleUsageSummaryRepository implements IUsageSummaryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getLastWindowEnd(): Promise<number> {
    const row = (await this.db.select({ lastEnd: max(usageSummaries.windowEnd) }).from(usageSummaries))[0];
    return row?.lastEnd ?? 0;
  }

  async getEarliestEventTimestamp(before: number): Promise<number | null> {
    const row = (
      await this.db
        .select({ ts: min(meterEvents.timestamp) })
        .from(meterEvents)
        .where(lt(meterEvents.timestamp, before))
    )[0];
    return row?.ts ?? null;
  }

  async getAggregatedEvents(windowStart: number, windowEnd: number): Promise<AggregatedWindowRow[]> {
    const rows = await this.db
      .select({
        tenant: meterEvents.tenant,
        capability: meterEvents.capability,
        provider: meterEvents.provider,
        eventCount: count(),
        totalCost: sum(meterEvents.cost),
        totalCharge: sum(meterEvents.charge),
        totalDuration: sql<number>`COALESCE(SUM(${meterEvents.duration}), 0)`,
      })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, windowStart), lt(meterEvents.timestamp, windowEnd)))
      .groupBy(meterEvents.tenant, meterEvents.capability, meterEvents.provider);

    return rows.map((r) => ({
      tenant: r.tenant,
      capability: r.capability,
      provider: r.provider,
      eventCount: r.eventCount,
      totalCost: Number(r.totalCost),
      totalCharge: Number(r.totalCharge),
      totalDuration: r.totalDuration,
    }));
  }

  async insertSummary(values: UsageSummaryInsert): Promise<void> {
    await this.db.insert(usageSummaries).values(values);
  }

  async insertSummariesBatch(rows: UsageSummaryInsert[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        await tx.insert(usageSummaries).values(row);
      }
    });
  }

  async querySummaries(
    tenant: string,
    opts: { since?: number; until?: number; limit?: number } = {},
  ): Promise<UsageSummary[]> {
    const conditions = [eq(usageSummaries.tenant, tenant)];
    if (opts.since != null) {
      conditions.push(gte(usageSummaries.windowStart, opts.since));
    }
    if (opts.until != null) {
      conditions.push(lte(usageSummaries.windowEnd, opts.until));
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);

    return this.db
      .select({
        tenant: usageSummaries.tenant,
        capability: usageSummaries.capability,
        provider: usageSummaries.provider,
        event_count: usageSummaries.eventCount,
        total_cost: usageSummaries.totalCost,
        total_charge: usageSummaries.totalCharge,
        total_duration: usageSummaries.totalDuration,
        window_start: usageSummaries.windowStart,
        window_end: usageSummaries.windowEnd,
      })
      .from(usageSummaries)
      .where(and(...conditions))
      .orderBy(desc(usageSummaries.windowStart))
      .limit(limit);
  }

  async getTenantTotal(
    tenant: string,
    since: number,
  ): Promise<{ totalCost: number; totalCharge: number; eventCount: number }> {
    const row = (
      await this.db
        .select({
          totalCost: sql<number>`COALESCE(SUM(${usageSummaries.totalCost}), 0)`,
          totalCharge: sql<number>`COALESCE(SUM(${usageSummaries.totalCharge}), 0)`,
          eventCount: sql<number>`COALESCE(SUM(${usageSummaries.eventCount}), 0)`,
        })
        .from(usageSummaries)
        .where(and(eq(usageSummaries.tenant, tenant), gte(usageSummaries.windowStart, since)))
    )[0];

    return {
      totalCost: row?.totalCost ?? 0,
      totalCharge: row?.totalCharge ?? 0,
      eventCount: row?.eventCount ?? 0,
    };
  }
}

export { DrizzleUsageSummaryRepository as UsageSummaryRepository };
