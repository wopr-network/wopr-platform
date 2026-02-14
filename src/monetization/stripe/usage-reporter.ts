import crypto from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
import type { DrizzleDb } from "../../db/index.js";
import { billingPeriodSummaries } from "../../db/schema/meter-events.js";
import { stripeUsageReports } from "../../db/schema/stripe.js";
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
  "image-generation": "wopr_image_generation_usage",
  "text-generation": "wopr_text_generation_usage",
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
    private readonly db: DrizzleDb,
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
    // Use a LEFT JOIN: select bps rows where there is no matching sur row.
    const unreported = this.db
      .select({
        tenant: billingPeriodSummaries.tenant,
        capability: billingPeriodSummaries.capability,
        provider: billingPeriodSummaries.provider,
        eventCount: billingPeriodSummaries.eventCount,
        totalCharge: billingPeriodSummaries.totalCharge,
        periodStart: billingPeriodSummaries.periodStart,
        periodEnd: billingPeriodSummaries.periodEnd,
      })
      .from(billingPeriodSummaries)
      .leftJoin(
        stripeUsageReports,
        and(
          eq(billingPeriodSummaries.tenant, stripeUsageReports.tenant),
          eq(billingPeriodSummaries.capability, stripeUsageReports.capability),
          eq(billingPeriodSummaries.provider, stripeUsageReports.provider),
          eq(billingPeriodSummaries.periodStart, stripeUsageReports.periodStart),
        ),
      )
      .where(and(isNull(stripeUsageReports.id), gt(billingPeriodSummaries.eventCount, 0)))
      .all()
      .filter((r) => r.tenant !== "__sentinel__");

    if (unreported.length === 0) {
      return 0;
    }

    let reported = 0;

    for (const row of unreported) {
      const mapping = this.tenantStore.getByTenant(row.tenant);
      if (!mapping) {
        // Tenant has no Stripe customer -- skip silently.
        // They may be on a free tier or not yet signed up.
        continue;
      }

      const eventName = this.meterEventNames[row.capability] ?? `wopr_${row.capability}_usage`;
      const valueCents = Math.round(row.totalCharge * 100);

      if (valueCents <= 0) {
        // Zero-value period -- mark as reported but don't send to Stripe.
        this.recordReport(row, eventName, 0);
        reported++;
        continue;
      }

      try {
        await this.stripe.billing.meterEvents.create({
          event_name: eventName,
          timestamp: Math.floor(row.periodStart / 1000), // Stripe expects seconds
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
    row: { tenant: string; capability: string; provider: string; periodStart: number; periodEnd: number },
    eventName: string,
    valueCents: number,
  ): void {
    this.db
      .insert(stripeUsageReports)
      .values({
        id: crypto.randomUUID(),
        tenant: row.tenant,
        capability: row.capability,
        provider: row.provider,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        eventName,
        valueCents,
        reportedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  /** Query reports for a tenant (for diagnostics). */
  queryReports(tenant: string, opts: { limit?: number } = {}): StripeUsageReportRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
    const rows = this.db
      .select()
      .from(stripeUsageReports)
      .where(eq(stripeUsageReports.tenant, tenant))
      .orderBy(desc(stripeUsageReports.periodStart))
      .limit(limit)
      .all();

    return rows.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      capability: r.capability,
      provider: r.provider,
      period_start: r.periodStart,
      period_end: r.periodEnd,
      event_name: r.eventName,
      value_cents: r.valueCents,
      reported_at: r.reportedAt,
    }));
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
