import crypto from "node:crypto";
import type { UsageSummary } from "./types.js";
import type { IUsageSummaryRepository } from "./usage-summary-repository.js";

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
    private readonly repo: IUsageSummaryRepository,
    opts: { windowMs?: number } = {},
  ) {
    this.windowMs = opts.windowMs ?? 60_000; // 1 minute default
  }

  /**
   * Aggregate all events in completed windows up to `now`.
   * Returns the number of summary rows inserted.
   */
  async aggregate(now: number = Date.now()): Promise<number> {
    let lastEnd = await this.repo.getLastWindowEnd();

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
      const earliest = await this.repo.getEarliestEventTimestamp(currentWindowStart);
      if (earliest != null) {
        lastEnd = Math.floor(earliest / this.windowMs) * this.windowMs;
      } else {
        // No events at all -- insert a single sentinel to mark we've processed up to now.
        await this.repo.insertSummary({
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
      const rows = await this.repo.getAggregatedEvents(windowStart, windowEnd);

      if (rows.length === 0) {
        // Advance past this empty window by inserting a sentinel with zero counts.
        await this.repo.insertSummary({
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
        await this.repo.insertSummariesBatch(
          rows.map((s) => ({
            id: crypto.randomUUID(),
            tenant: s.tenant,
            capability: s.capability,
            provider: s.provider,
            eventCount: s.eventCount,
            totalCost: s.totalCost,
            totalCharge: s.totalCharge,
            totalDuration: s.totalDuration,
            windowStart,
            windowEnd,
          })),
        );
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
    return this.repo.querySummaries(tenant, opts);
  }

  /** Get a tenant's total usage across all capabilities since a given time. */
  async getTenantTotal(
    tenant: string,
    since: number,
  ): Promise<{ totalCost: number; totalCharge: number; eventCount: number }> {
    return this.repo.getTenantTotal(tenant, since);
  }
}

// Backward-compat alias.
export { DrizzleMeterAggregator as MeterAggregator };
