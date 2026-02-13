import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { UsageSummary } from "./types.js";

/**
 * Background aggregator that rolls up raw meter events into per-tenant
 * usage summaries over fixed time windows.
 *
 * Designed to run periodically (e.g., every minute). Each run aggregates
 * events from a completed window that haven't been summarized yet.
 */
export class MeterAggregator {
  private readonly windowMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database.Database,
    opts: { windowMs?: number } = {},
  ) {
    this.windowMs = opts.windowMs ?? 60_000; // 1 minute default
  }

  /**
   * Aggregate all events in completed windows up to `now`.
   * Returns the number of summary rows inserted.
   */
  aggregate(now: number = Date.now()): number {
    // Find the latest window_end already aggregated.
    const lastRow = this.db.prepare("SELECT MAX(window_end) as last_end FROM usage_summaries").get() as {
      last_end: number | null;
    };

    let lastEnd = lastRow.last_end ?? 0;

    // Calculate the current window boundary. We only aggregate *completed* windows.
    const currentWindowStart = Math.floor(now / this.windowMs) * this.windowMs;

    if (lastEnd >= currentWindowStart) {
      // Nothing new to aggregate.
      return 0;
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO usage_summaries
        (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, window_start, window_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalInserted = 0;

    // Process one window at a time to respect fixed time window boundaries.
    // On first run (lastEnd === 0), align to the first window boundary at or
    // before currentWindowStart so we don't create thousands of empty sentinels.
    if (lastEnd === 0) {
      // Find earliest event to anchor the first window.
      const earliest = this.db
        .prepare("SELECT MIN(timestamp) as ts FROM meter_events WHERE timestamp < ?")
        .get(currentWindowStart) as { ts: number | null };
      if (earliest.ts != null) {
        lastEnd = Math.floor(earliest.ts / this.windowMs) * this.windowMs;
      } else {
        // No events at all — insert a single sentinel to mark we've processed up to now.
        insertStmt.run(
          crypto.randomUUID(),
          "__sentinel__",
          "__none__",
          "__none__",
          0,
          0,
          0,
          0,
          0,
          currentWindowStart,
        );
        return 0;
      }
    }

    while (lastEnd < currentWindowStart) {
      const windowStart = lastEnd;
      const windowEnd = Math.min(lastEnd + this.windowMs, currentWindowStart);

      // Group events by tenant + capability + provider within this single window.
      const rows = this.db
        .prepare(
          `SELECT
            tenant,
            capability,
            provider,
            COUNT(*) as event_count,
            SUM(cost) as total_cost,
            SUM(charge) as total_charge,
            COALESCE(SUM(duration), 0) as total_duration
          FROM meter_events
          WHERE timestamp >= ? AND timestamp < ?
          GROUP BY tenant, capability, provider`,
        )
        .all(windowStart, windowEnd) as Array<{
        tenant: string;
        capability: string;
        provider: string;
        event_count: number;
        total_cost: number;
        total_charge: number;
        total_duration: number;
      }>;

      if (rows.length === 0) {
        // Advance past this empty window by inserting a sentinel with zero counts.
        insertStmt.run(
          crypto.randomUUID(),
          "__sentinel__",
          "__none__",
          "__none__",
          0,
          0,
          0,
          0,
          windowStart,
          windowEnd,
        );
      } else {
        const insertAll = this.db.transaction(
          (
            summaries: Array<{
              tenant: string;
              capability: string;
              provider: string;
              event_count: number;
              total_cost: number;
              total_charge: number;
              total_duration: number;
            }>,
          ) => {
            for (const s of summaries) {
              insertStmt.run(
                crypto.randomUUID(),
                s.tenant,
                s.capability,
                s.provider,
                s.event_count,
                s.total_cost,
                s.total_charge,
                s.total_duration,
                windowStart,
                windowEnd,
              );
            }
          },
        );

        insertAll(rows);
        totalInserted += rows.length;
      }

      lastEnd = windowEnd;
    }

    return totalInserted;
  }

  /** Start periodic aggregation. */
  start(intervalMs?: number): void {
    if (this.timer) {
      return; // Already running — avoid leaking a second interval timer.
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
  querySummaries(tenant: string, opts: { since?: number; until?: number; limit?: number } = {}): UsageSummary[] {
    const conditions: string[] = ["tenant = ?"];
    const params: unknown[] = [tenant];

    if (opts.since != null) {
      conditions.push("window_start >= ?");
      params.push(opts.since);
    }
    if (opts.until != null) {
      conditions.push("window_end <= ?");
      params.push(opts.until);
    }

    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
    const where = conditions.join(" AND ");

    return this.db
      .prepare(
        `SELECT tenant, capability, provider, event_count, total_cost, total_charge, total_duration, window_start, window_end
         FROM usage_summaries WHERE ${where} ORDER BY window_start DESC LIMIT ?`,
      )
      .all(...params, limit) as UsageSummary[];
  }

  /** Get a tenant's total usage across all capabilities since a given time. */
  getTenantTotal(tenant: string, since: number): { totalCost: number; totalCharge: number; eventCount: number } {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(total_cost), 0) as totalCost,
          COALESCE(SUM(total_charge), 0) as totalCharge,
          COALESCE(SUM(event_count), 0) as eventCount
        FROM usage_summaries
        WHERE tenant = ? AND window_start >= ?`,
      )
      .get(tenant, since) as { totalCost: number; totalCharge: number; eventCount: number };

    return row;
  }
}
