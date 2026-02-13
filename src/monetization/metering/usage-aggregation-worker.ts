import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { BillingPeriod, BillingPeriodSummary, StripeMeterRecord } from "./types.js";

/** Default billing period: 1 hour. */
const DEFAULT_PERIOD_MS = 3_600_000;

/**
 * Stripe meter event name mapping.
 * Maps capability names to Stripe meter event names.
 * Consumers configure actual Stripe Meter objects in their dashboard
 * and pass the mapping here.
 */
export type MeterEventNameMap = Record<string, string>;

const DEFAULT_EVENT_NAMES: MeterEventNameMap = {
  embeddings: "wopr_embeddings_usage",
  chat: "wopr_chat_usage",
  voice: "wopr_voice_usage",
  stt: "wopr_stt_usage",
  tts: "wopr_tts_usage",
  search: "wopr_search_usage",
};

export interface UsageAggregationWorkerOpts {
  /** Billing period duration in ms (default: 1 hour). */
  periodMs?: number;
  /** How often the worker runs in ms (default: same as periodMs). */
  intervalMs?: number;
  /** Mapping of capability -> Stripe meter event_name. */
  meterEventNames?: MeterEventNameMap;
  /**
   * Grace period in ms for late-arriving events.
   * The worker will re-aggregate periods that ended within this window.
   * Default: 5 minutes.
   */
  lateArrivalGraceMs?: number;
}

/**
 * Background worker that rolls up raw meter_events into per-tenant
 * billing-period summaries and produces Stripe-compatible meter records.
 *
 * Sits between the MeterEmitter (WOP-299) and Stripe billing (WOP-300).
 *
 * Design:
 * - Reads directly from `meter_events` (the append-only event log)
 * - Writes to `billing_period_summaries` (UPSERT -- idempotent)
 * - Late-arriving events are handled by re-aggregating the grace window
 *   from raw events on every pass
 * - Produces StripeMeterRecord[] that Stripe billing integration can POST
 */
export class UsageAggregationWorker {
  private readonly periodMs: number;
  private readonly intervalMs: number;
  private readonly meterEventNames: MeterEventNameMap;
  private readonly lateArrivalGraceMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly upsertStmt: Database.Statement;
  private readonly upsertTransaction: Database.Transaction<
    (
      rows: Array<{
        id: string;
        tenant: string;
        capability: string;
        provider: string;
        event_count: number;
        total_cost: number;
        total_charge: number;
        total_duration: number;
        period_start: number;
        period_end: number;
        updated_at: number;
      }>,
    ) => void
  >;

  constructor(
    private readonly db: Database.Database,
    opts: UsageAggregationWorkerOpts = {},
  ) {
    this.periodMs = opts.periodMs ?? DEFAULT_PERIOD_MS;
    this.intervalMs = opts.intervalMs ?? this.periodMs;
    this.meterEventNames = { ...DEFAULT_EVENT_NAMES, ...opts.meterEventNames };
    this.lateArrivalGraceMs = opts.lateArrivalGraceMs ?? 300_000; // 5 min

    this.upsertStmt = db.prepare(`
      INSERT INTO billing_period_summaries
        (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant, capability, provider, period_start) DO UPDATE SET
        event_count = excluded.event_count,
        total_cost = excluded.total_cost,
        total_charge = excluded.total_charge,
        total_duration = excluded.total_duration,
        updated_at = excluded.updated_at
    `);

    this.upsertTransaction = db.transaction(
      (
        rows: Array<{
          id: string;
          tenant: string;
          capability: string;
          provider: string;
          event_count: number;
          total_cost: number;
          total_charge: number;
          total_duration: number;
          period_start: number;
          period_end: number;
          updated_at: number;
        }>,
      ) => {
        for (const r of rows) {
          this.upsertStmt.run(
            r.id,
            r.tenant,
            r.capability,
            r.provider,
            r.event_count,
            r.total_cost,
            r.total_charge,
            r.total_duration,
            r.period_start,
            r.period_end,
            r.updated_at,
          );
        }
      },
    );
  }

  /** Compute the billing period boundaries for a given timestamp. */
  getBillingPeriod(timestamp: number): BillingPeriod {
    const start = Math.floor(timestamp / this.periodMs) * this.periodMs;
    return { start, end: start + this.periodMs };
  }

  /**
   * Run one aggregation pass.
   * Reads directly from meter_events and rolls them into billing_period_summaries.
   * Re-aggregates the grace window on every pass to handle late-arriving events.
   *
   * Returns the number of billing_period_summary rows upserted.
   */
  aggregate(now: number = Date.now()): number {
    const currentPeriod = this.getBillingPeriod(now);

    // Re-aggregate from (currentPeriodStart - graceMs) to catch late arrivals.
    const graceStart = this.getBillingPeriod(currentPeriod.start - this.lateArrivalGraceMs).start;

    // For periods older than the grace window, check what we've already covered.
    const existingMax = this.db.prepare("SELECT MAX(period_end) as max_end FROM billing_period_summaries").get() as {
      max_end: number | null;
    };

    // Determine the lower bound for aggregation.
    let lowerBound: number;
    if (existingMax.max_end != null) {
      // Re-aggregate from grace window (handles late arrivals) OR from last covered point
      // -- whichever is earlier.
      lowerBound = Math.min(graceStart, existingMax.max_end);
    } else {
      // First run: find earliest meter event.
      const earliest = this.db.prepare("SELECT MIN(timestamp) as min_ts FROM meter_events").get() as {
        min_ts: number | null;
      };

      if (earliest.min_ts == null) {
        return 0; // No data at all.
      }
      lowerBound = this.getBillingPeriod(earliest.min_ts).start;
    }

    // Only aggregate completed billing periods (before currentPeriod.start).
    const upperBound = currentPeriod.start;

    if (lowerBound >= upperBound) {
      return 0;
    }

    // Aggregate directly from meter_events, grouped by tenant + capability + provider
    // + billing period boundary.
    const groupedRows = this.db
      .prepare(
        `SELECT
          tenant,
          capability,
          provider,
          COUNT(*) as event_count,
          SUM(cost) as total_cost,
          SUM(charge) as total_charge,
          COALESCE(SUM(duration), 0) as total_duration,
          (CAST(timestamp / ? AS INTEGER) * ?) as period_start
        FROM meter_events
        WHERE timestamp >= ?
          AND timestamp < ?
        GROUP BY tenant, capability, provider,
          CAST(timestamp / ? AS INTEGER)`,
      )
      .all(this.periodMs, this.periodMs, lowerBound, upperBound, this.periodMs) as Array<{
      tenant: string;
      capability: string;
      provider: string;
      event_count: number;
      total_cost: number;
      total_charge: number;
      total_duration: number;
      period_start: number;
    }>;

    if (groupedRows.length === 0) {
      return 0;
    }

    const upsertRows = groupedRows.map((r) => ({
      id: crypto.randomUUID(),
      tenant: r.tenant,
      capability: r.capability,
      provider: r.provider,
      event_count: r.event_count,
      total_cost: r.total_cost,
      total_charge: r.total_charge,
      total_duration: r.total_duration,
      period_start: r.period_start,
      period_end: r.period_start + this.periodMs,
      updated_at: now,
    }));

    this.upsertTransaction(upsertRows);
    return upsertRows.length;
  }

  /** Start periodic aggregation. */
  start(intervalMs?: number): void {
    if (this.timer) {
      return;
    }
    const interval = intervalMs ?? this.intervalMs;
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

  /**
   * Query billing period summaries for a tenant.
   */
  querySummaries(
    tenant: string,
    opts: { since?: number; until?: number; limit?: number } = {},
  ): BillingPeriodSummary[] {
    const conditions: string[] = ["tenant = ?"];
    const params: unknown[] = [tenant];

    if (opts.since != null) {
      conditions.push("period_start >= ?");
      params.push(opts.since);
    }
    if (opts.until != null) {
      conditions.push("period_end <= ?");
      params.push(opts.until);
    }

    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
    const where = conditions.join(" AND ");

    return this.db
      .prepare(
        `SELECT id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at
         FROM billing_period_summaries WHERE ${where} ORDER BY period_start DESC LIMIT ?`,
      )
      .all(...params, limit) as BillingPeriodSummary[];
  }

  /**
   * Produce Stripe Meter API-compatible records for unreported billing periods.
   * Returns records for all completed billing periods for a given tenant.
   */
  toStripeMeterRecords(
    tenant: string,
    opts: { since?: number; until?: number; customerIdMap?: Record<string, string> } = {},
  ): StripeMeterRecord[] {
    const summaries = this.querySummaries(tenant, {
      since: opts.since,
      until: opts.until,
    });

    const stripeCustomerId = opts.customerIdMap?.[tenant] ?? tenant;

    return summaries
      .filter((s) => s.event_count > 0)
      .map((s) => ({
        event_name: this.meterEventNames[s.capability] ?? `wopr_${s.capability}_usage`,
        timestamp: Math.floor(s.period_start / 1000), // Stripe expects seconds
        payload: {
          stripe_customer_id: stripeCustomerId,
          // Stripe meter values are strings; charge in cents, rounded to avoid floating point.
          value: String(Math.round(s.total_charge * 100)),
        },
      }));
  }

  /**
   * Get a tenant's total usage across all capabilities for a billing period range.
   */
  getTenantPeriodTotal(
    tenant: string,
    since: number,
  ): { totalCost: number; totalCharge: number; eventCount: number; totalDuration: number } {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(total_cost), 0) as totalCost,
          COALESCE(SUM(total_charge), 0) as totalCharge,
          COALESCE(SUM(event_count), 0) as eventCount,
          COALESCE(SUM(total_duration), 0) as totalDuration
        FROM billing_period_summaries
        WHERE tenant = ? AND period_start >= ?`,
      )
      .get(tenant, since) as { totalCost: number; totalCharge: number; eventCount: number; totalDuration: number };

    return row;
  }
}
