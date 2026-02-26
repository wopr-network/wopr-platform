import { logger } from "../../config/logger.js";
import type { NotificationService } from "../../email/notification-service.js";
import type { IDividendRepository } from "./dividend-repository.js";

export interface DividendDigestConfig {
  dividendRepo: IDividendRepository;
  notificationService: NotificationService;
  appBaseUrl: string;
  digestDate: string;
  minTotalCents?: number;
}

export interface DividendDigestResult {
  qualified: number;
  enqueued: number;
  skipped: number;
  errors: string[];
}

/** Subtract N days from a YYYY-MM-DD date string, returning YYYY-MM-DD. */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Add N days to a YYYY-MM-DD date string, returning YYYY-MM-DD. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

function formatDateFull(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function runDividendDigestCron(cfg: DividendDigestConfig): Promise<DividendDigestResult> {
  const result: DividendDigestResult = { qualified: 0, enqueued: 0, skipped: 0, errors: [] };
  const minCents = cfg.minTotalCents ?? 1;

  // Window: [digestDate - 7 days, digestDate)
  const windowStart = subtractDays(cfg.digestDate, 7);
  const windowEnd = cfg.digestDate;

  const tenantAggregates = await cfg.dividendRepo.getDigestTenantAggregates(windowStart, windowEnd);

  for (const agg of tenantAggregates) {
    // Check threshold
    if (agg.totalCents < minCents) {
      result.skipped++;
      continue;
    }

    // Resolve email from admin_users via repository
    const email = await cfg.dividendRepo.getTenantEmail(agg.tenantId);

    if (!email) {
      result.skipped++;
      logger.debug("Dividend digest: no email for tenant", { tenantId: agg.tenantId });
      continue;
    }

    result.qualified++;

    // Compute lifetime total
    const lifetimeCents = await cfg.dividendRepo.getLifetimeTotalCents(agg.tenantId);

    // Next dividend date = tomorrow (dividends run nightly)
    const nextDividendDate = formatDateFull(addDays(cfg.digestDate, 1));

    try {
      cfg.notificationService.notifyDividendWeeklyDigest(
        agg.tenantId,
        email,
        centsToDollars(agg.totalCents),
        agg.totalCents,
        centsToDollars(lifetimeCents),
        agg.distributionCount,
        agg.avgPoolCents,
        agg.avgActiveUsers,
        nextDividendDate,
        formatDate(windowStart),
        formatDate(subtractDays(cfg.digestDate, 1)),
      );
      result.enqueued++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Dividend digest enqueue failed", { tenantId: agg.tenantId, error: msg });
      result.errors.push(`${agg.tenantId}: ${msg}`);
    }
  }

  logger.info("Dividend digest cron complete", {
    digestDate: cfg.digestDate,
    qualified: result.qualified,
    enqueued: result.enqueued,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}
