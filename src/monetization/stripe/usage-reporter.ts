import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
import type { MeterEventNameMap } from "../metering/usage-aggregation-worker.js";
import type { TenantCustomerStore } from "./tenant-store.js";
import type { StripeUsageReportRow } from "./types.js";

const DEFAULT_EVENT_NAMES: MeterEventNameMap = {
  embeddings: "wopr_embeddings_usage",
  chat: "wopr_chat_usage",
  voice: "wopr_voice_usage",
  stt: "wopr_stt_usage",
  tts: "wopr_tts_usage",
  search: "wopr_search_usage",
};

export interface UsageReporterOpts {
  /** Mapping of capability -> Stripe meter event_name. */
  meterEventNames?: MeterEventNameMap;
  /** How often to run reporting in ms (default: 5 minutes). */
  intervalMs?: number;
}

/**
 * Reports aggregated usage from billing_period_summaries to the Stripe Meters API.
 *
 * This is the bridge between WOPR's usage aggregation (WOP-284) and Stripe billing.
 * It reads completed billing periods that haven't been reported yet and sends
 * meter events to Stripe. Reporting is idempotent via the stripe_usage_reports table.
 *
 * Design:
 * - Reads from billing_period_summaries (produced by UsageAggregationWorker)
 * - Checks stripe_usage_reports to skip already-reported periods
 * - Sends meter events to Stripe via billing.meterEvents.create()
 * - Records successful reports in stripe_usage_reports
 */
export class StripeUsageReporter {
  private readonly meterEventNames: MeterEventNameMap;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly stripe: Stripe,
    private readonly tenantStore: TenantCustomerStore,
    opts: UsageReporterOpts = {},
  ) {
    this.meterEventNames = { ...DEFAULT_EVENT_NAMES, ...opts.meterEventNames };
    this.intervalMs = opts.intervalMs ?? 300_000; // 5 minutes
  }

  /**
   * Report all unreported billing period summaries to Stripe.
   * Returns the number of meter events successfully reported.
   */
  async report(): Promise<number> {
    // Find billing period summaries that haven't been reported yet.
    const unreported = this.db
      .prepare(
        `SELECT bps.tenant, bps.capability, bps.provider, bps.event_count,
                bps.total_charge, bps.period_start, bps.period_end
         FROM billing_period_summaries bps
         LEFT JOIN stripe_usage_reports sur
           ON bps.tenant = sur.tenant
           AND bps.capability = sur.capability
           AND bps.provider = sur.provider
           AND bps.period_start = sur.period_start
         WHERE sur.id IS NULL
           AND bps.event_count > 0
           AND bps.tenant != '__sentinel__'
         ORDER BY bps.period_start ASC`,
      )
      .all() as Array<{
      tenant: string;
      capability: string;
      provider: string;
      event_count: number;
      total_charge: number;
      period_start: number;
      period_end: number;
    }>;

    if (unreported.length === 0) {
      return 0;
    }

    let reported = 0;

    for (const row of unreported) {
      const mapping = this.tenantStore.getByTenant(row.tenant);
      if (!mapping) {
        // Tenant has no Stripe customer — skip silently.
        // They may be on a free tier or not yet signed up.
        continue;
      }

      const eventName = this.meterEventNames[row.capability] ?? `wopr_${row.capability}_usage`;
      const valueCents = Math.round(row.total_charge * 100);

      if (valueCents <= 0) {
        // Zero-value period — mark as reported but don't send to Stripe.
        this.recordReport(row, eventName, 0);
        reported++;
        continue;
      }

      try {
        await this.stripe.billing.meterEvents.create({
          event_name: eventName,
          timestamp: Math.floor(row.period_start / 1000), // Stripe expects seconds
          payload: {
            stripe_customer_id: mapping.stripe_customer_id,
            value: String(valueCents),
          },
        });

        this.recordReport(row, eventName, valueCents);
        reported++;
      } catch (err) {
        logger.error("Failed to report usage to Stripe", {
          tenant: row.tenant,
          capability: row.capability,
          error: err instanceof Error ? err.message : String(err),
        });
        // Stop on first error to avoid hammering a failing API.
        // The idempotent design means we'll retry on the next pass.
        break;
      }
    }

    return reported;
  }

  /** Record a successful usage report to prevent re-reporting. */
  private recordReport(
    row: { tenant: string; capability: string; provider: string; period_start: number; period_end: number },
    eventName: string,
    valueCents: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_usage_reports
           (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        row.tenant,
        row.capability,
        row.provider,
        row.period_start,
        row.period_end,
        eventName,
        valueCents,
        Date.now(),
      );
  }

  /** Query reports for a tenant (for diagnostics). */
  queryReports(tenant: string, opts: { limit?: number } = {}): StripeUsageReportRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
    return this.db
      .prepare(`SELECT * FROM stripe_usage_reports WHERE tenant = ? ORDER BY period_start DESC LIMIT ?`)
      .all(tenant, limit) as StripeUsageReportRow[];
  }

  /** Start periodic reporting. */
  start(intervalMs?: number): void {
    if (this.timer) return;
    const interval = intervalMs ?? this.intervalMs;
    this.timer = setInterval(() => {
      void this.report();
    }, interval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /** Stop periodic reporting. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
