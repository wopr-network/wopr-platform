import crypto from "node:crypto";
import { and, count, desc, eq, gte, lt, lte, max, min, sql, sum } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import type { UsageSummary } from "./types.js";

export interface IMeterAggregator {
  aggregate(now?: number): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
  querySummaries(tenant: string, opts?: { since?: number; until?: number; limit?: number }): Promise<UsageSummary[]>;
  getTenantTotal(
    tenant: string,
    since: number,
  ): Promise<{ totalCost: number; totalCharge: number; eventCount: number }>;
}

/**
 * Background aggregator that rolls up raw meter events into per-tenant
 * usage summaries over fixed time windows.
 *
 * Designed to run periodically (e.g., every minute). Each run aggregates
 * events from a completed window that haven't been summarized yet.
 */
export class DrizzleMeterAggregator implements IMeterAggregator {
  private readonly windowMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DrizzleDb,
    opts: { windowMs?: number } = {},
  ) {
    this.windowMs = opts.windowMs ?? 60_000; // 1 minute default
  }

  /**
   * Aggregate all events in completed windows up to `now`.
   * Returns the number of summary rows inserted.
   */
  async aggregate(now: number = Date.now()): Promise<number> {
    // Find the latest window_end already aggregated.
    const lastRow = (await this.db.select({ lastEnd: max(usageSummaries.windowEnd) }).from(usageSummaries))[0];

    let lastEnd = lastRow?.lastEnd ?? 0;

    // Calculate the current window boundary. We only aggregate *completed* windows.
    const currentWindowStart = Math.floor(now / this.windowMs) * this.windowMs;

    if (lastEnd >= currentWindowStart) {
      // Nothing new to aggregate.
      return 0;
    }

    let totalInserted = 0;

    // Process one window at a time to respect fixed time window boundaries.
    // On first run (lastEnd === 0), align to the first window boundary at or
    // before currentWindowStart so we don't create thousands of empty sentinels.
    if (lastEnd === 0) {
      // Find earliest event to anchor the first window.
      const earliest = (
        await this.db
          .select({ ts: min(meterEvents.timestamp) })
          .from(meterEvents)
          .where(lt(meterEvents.timestamp, currentWindowStart))
      )[0];
      if (earliest?.ts != null) {
        lastEnd = Math.floor(earliest.ts / this.windowMs) * this.windowMs;
      } else {
        // No events at all -- insert a single sentinel to mark we've processed up to now.
        await this.db.insert(usageSummaries).values({
          id: crypto.randomUUID(),
          tenant: "__sentinel__",
          capability: "__none__",
          provider: "__none__",
          eventCount: 0,
          totalCost: 0,
          totalCharge: 0,
          totalDuration: 0,
          windowStart: 0,
          windowEnd: currentWindowStart,
        });
        return 0;
      }
    }

    while (lastEnd < currentWindowStart) {
      const windowStart = lastEnd;
      const windowEnd = Math.min(lastEnd + this.windowMs, currentWindowStart);

      // Group events by tenant + capability + provider within this single window.
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

      if (rows.length === 0) {
        // Advance past this empty window by inserting a sentinel with zero counts.
        await this.db.insert(usageSummaries).values({
          id: crypto.randomUUID(),
          tenant: "__sentinel__",
          capability: "__none__",
          provider: "__none__",
          eventCount: 0,
          totalCost: 0,
          totalCharge: 0,
          totalDuration: 0,
          windowStart,
          windowEnd,
        });
      } else {
        await this.db.transaction(async (tx) => {
          for (const s of rows) {
            await tx.insert(usageSummaries).values({
              id: crypto.randomUUID(),
              tenant: s.tenant,
              capability: s.capability,
              provider: s.provider,
              eventCount: s.eventCount,
              totalCost: Number(s.totalCost),
              totalCharge: Number(s.totalCharge),
              totalDuration: s.totalDuration,
              windowStart,
              windowEnd,
            });
          }
        });
        totalInserted += rows.length;
      }

      lastEnd = windowEnd;
    }

    return totalInserted;
  }

  /** Start periodic aggregation. */
  start(intervalMs?: number): void {
    if (this.timer) {
      return; // Already running -- avoid leaking a second interval timer.
    }
    const interval = intervalMs ?? this.windowMs;
    this.timer = setInterval(() => this.aggregate(), interval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /** Stop periodic aggregation. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Query usage summaries for a tenant within a time range. */
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

    const rows = await this.db
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

    return rows;
  }

  /** Get a tenant's total usage across all capabilities since a given time. */
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

// Backward-compat alias.
export { DrizzleMeterAggregator as MeterAggregator };
