import crypto from "node:crypto";
import { and, count, desc, eq, gte, lt, lte, max, min, sql, sum } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { billingPeriodSummaries, meterEvents } from "../../db/schema/meter-events.js";
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
  "image-generation": "wopr_image_generation_usage",
  "text-generation": "wopr_text_generation_usage",
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

export interface IUsageAggregationWorker {
  getBillingPeriod(timestamp: number): BillingPeriod;
  aggregate(now?: number): number;
  start(intervalMs?: number): void;
  stop(): void;
  querySummaries(tenant: string, opts?: { since?: number; until?: number; limit?: number }): BillingPeriodSummary[];
  toStripeMeterRecords(
    tenant: string,
    opts?: { since?: number; until?: number; customerIdMap?: Record<string, string> },
  ): StripeMeterRecord[];
  getTenantPeriodTotal(
    tenant: string,
    since: number,
  ): { totalCost: number; totalCharge: number; eventCount: number; totalDuration: number };
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
export class DrizzleUsageAggregationWorker implements IUsageAggregationWorker {
  private readonly periodMs: number;
  private readonly intervalMs: number;
  private readonly meterEventNames: MeterEventNameMap;
  private readonly lateArrivalGraceMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DrizzleDb,
    opts: UsageAggregationWorkerOpts = {},
  ) {
    this.periodMs = opts.periodMs ?? DEFAULT_PERIOD_MS;
    this.intervalMs = opts.intervalMs ?? this.periodMs;
    this.meterEventNames = { ...DEFAULT_EVENT_NAMES, ...opts.meterEventNames };
    this.lateArrivalGraceMs = opts.lateArrivalGraceMs ?? 300_000; // 5 min
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
    const existingMax = this.db
      .select({ maxEnd: max(billingPeriodSummaries.periodEnd) })
      .from(billingPeriodSummaries)
      .get();

    // Determine the lower bound for aggregation.
    let lowerBound: number;
    if (existingMax?.maxEnd != null) {
      // Re-aggregate from grace window (handles late arrivals) OR from last covered point
      // -- whichever is earlier.
      lowerBound = Math.min(graceStart, existingMax.maxEnd);
    } else {
      // First run: find earliest meter event.
      const earliest = this.db
        .select({ minTs: min(meterEvents.timestamp) })
        .from(meterEvents)
        .get();

      if (earliest?.minTs == null) {
        return 0; // No data at all.
      }
      lowerBound = this.getBillingPeriod(earliest.minTs).start;
    }

    // Only aggregate completed billing periods (before currentPeriod.start).
    const upperBound = currentPeriod.start;

    if (lowerBound >= upperBound) {
      return 0;
    }

    // Aggregate directly from meter_events, grouped by tenant + capability + provider
    // + billing period boundary.
    const periodMs = this.periodMs;
    const groupedRows = this.db
      .select({
        tenant: meterEvents.tenant,
        capability: meterEvents.capability,
        provider: meterEvents.provider,
        eventCount: count(),
        totalCost: sum(meterEvents.cost),
        totalCharge: sum(meterEvents.charge),
        totalDuration: sql<number>`COALESCE(SUM(${meterEvents.duration}), 0)`,
        periodStart: sql<number>`(CAST(${meterEvents.timestamp} / ${periodMs} AS INTEGER) * ${periodMs})`,
      })
      .from(meterEvents)
      .where(and(gte(meterEvents.timestamp, lowerBound), lt(meterEvents.timestamp, upperBound)))
      .groupBy(
        meterEvents.tenant,
        meterEvents.capability,
        meterEvents.provider,
        sql`CAST(${meterEvents.timestamp} / ${periodMs} AS INTEGER)`,
      )
      .all();

    if (groupedRows.length === 0) {
      // Persist a sentinel row so that MAX(period_end) advances past this empty
      // range. Without this, every subsequent run rescans the entire gap.
      this.db
        .insert(billingPeriodSummaries)
        .values({
          id: crypto.randomUUID(),
          tenant: "__sentinel__",
          capability: "__none__",
          provider: "__none__",
          eventCount: 0,
          totalCost: 0,
          totalCharge: 0,
          totalDuration: 0,
          periodStart: upperBound - this.periodMs,
          periodEnd: upperBound,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            billingPeriodSummaries.tenant,
            billingPeriodSummaries.capability,
            billingPeriodSummaries.provider,
            billingPeriodSummaries.periodStart,
          ],
          set: {
            eventCount: 0,
            totalCost: 0,
            totalCharge: 0,
            totalDuration: 0,
            periodEnd: upperBound,
            updatedAt: now,
          },
        })
        .run();
      return 0;
    }

    const upsertRows = groupedRows.map((r) => ({
      id: crypto.randomUUID(),
      tenant: r.tenant,
      capability: r.capability,
      provider: r.provider,
      eventCount: r.eventCount,
      totalCost: Number(r.totalCost),
      totalCharge: Number(r.totalCharge),
      totalDuration: r.totalDuration,
      periodStart: r.periodStart,
      periodEnd: r.periodStart + this.periodMs,
      updatedAt: now,
    }));

    this.db.transaction((tx) => {
      for (const r of upsertRows) {
        tx.insert(billingPeriodSummaries)
          .values(r)
          .onConflictDoUpdate({
            target: [
              billingPeriodSummaries.tenant,
              billingPeriodSummaries.capability,
              billingPeriodSummaries.provider,
              billingPeriodSummaries.periodStart,
            ],
            set: {
              eventCount: r.eventCount,
              totalCost: r.totalCost,
              totalCharge: r.totalCharge,
              totalDuration: r.totalDuration,
              periodEnd: r.periodEnd,
              updatedAt: r.updatedAt,
            },
          })
          .run();
      }
    });

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
    const conditions = [eq(billingPeriodSummaries.tenant, tenant)];

    if (opts.since != null) {
      conditions.push(gte(billingPeriodSummaries.periodStart, opts.since));
    }
    if (opts.until != null) {
      conditions.push(lte(billingPeriodSummaries.periodEnd, opts.until));
    }

    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);

    const rows = this.db
      .select()
      .from(billingPeriodSummaries)
      .where(and(...conditions))
      .orderBy(desc(billingPeriodSummaries.periodStart))
      .limit(limit)
      .all();

    // Map to BillingPeriodSummary interface (snake_case)
    return rows.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      capability: r.capability,
      provider: r.provider,
      event_count: r.eventCount,
      total_cost: r.totalCost,
      total_charge: r.totalCharge,
      total_duration: r.totalDuration,
      period_start: r.periodStart,
      period_end: r.periodEnd,
      updated_at: r.updatedAt,
    }));
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
      .select({
        totalCost: sql<number>`COALESCE(SUM(${billingPeriodSummaries.totalCost}), 0)`,
        totalCharge: sql<number>`COALESCE(SUM(${billingPeriodSummaries.totalCharge}), 0)`,
        eventCount: sql<number>`COALESCE(SUM(${billingPeriodSummaries.eventCount}), 0)`,
        totalDuration: sql<number>`COALESCE(SUM(${billingPeriodSummaries.totalDuration}), 0)`,
      })
      .from(billingPeriodSummaries)
      .where(and(eq(billingPeriodSummaries.tenant, tenant), gte(billingPeriodSummaries.periodStart, since)))
      .get();

    return {
      totalCost: row?.totalCost ?? 0,
      totalCharge: row?.totalCharge ?? 0,
      eventCount: row?.eventCount ?? 0,
      totalDuration: row?.totalDuration ?? 0,
    };
  }
}

// Backward-compat alias.
export { DrizzleUsageAggregationWorker as UsageAggregationWorker };
