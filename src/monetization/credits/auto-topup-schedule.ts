import { logger } from "../../config/logger.js";
import type { Credit } from "../credit.js";
import type { AutoTopupChargeResult } from "./auto-topup-charge.js";
import { MAX_CONSECUTIVE_FAILURES } from "./auto-topup-charge.js";
import type { IAutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";

export interface ScheduleTopupDeps {
  settingsRepo: IAutoTopupSettingsRepository;
  chargeAutoTopup: (tenantId: string, amount: Credit, source: string) => Promise<AutoTopupChargeResult>;
}

export interface ScheduleTopupResult {
  processed: number;
  succeeded: string[];
  failed: string[];
  errors: string[];
}

/**
 * Run scheduled auto-topup charges for all due tenants.
 *
 * Called by an hourly cron job. For each tenant with schedule_next_at <= now:
 * 1. Charge Stripe
 * 2. Advance schedule_next_at by interval_hours (even on failure)
 * 3. Track failures and disable after MAX_CONSECUTIVE_FAILURES
 */
export async function runScheduledTopups(deps: ScheduleTopupDeps): Promise<ScheduleTopupResult> {
  const now = new Date().toISOString();
  const due = await deps.settingsRepo.listDueScheduled(now);

  const result: ScheduleTopupResult = {
    processed: 0,
    succeeded: [],
    failed: [],
    errors: [],
  };

  for (const settings of due) {
    result.processed++;

    try {
      const chargeResult = await deps.chargeAutoTopup(
        settings.tenantId,
        settings.scheduleAmount,
        "auto_topup_schedule",
      );

      // Always advance schedule_next_at (even on failure, to prevent hammer-retry)
      await deps.settingsRepo.advanceScheduleNextAt(settings.tenantId);

      if (chargeResult.success) {
        await deps.settingsRepo.resetScheduleFailures(settings.tenantId);
        result.succeeded.push(settings.tenantId);
      } else {
        const failureCount = await deps.settingsRepo.incrementScheduleFailures(settings.tenantId);
        if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
          await deps.settingsRepo.disableSchedule(settings.tenantId);
          logger.warn("Schedule auto-topup disabled after consecutive failures", {
            tenantId: settings.tenantId,
            failureCount,
          });
        }
        result.failed.push(settings.tenantId);
      }
    } catch (err) {
      // Advance even on unexpected error
      await deps.settingsRepo.advanceScheduleNextAt(settings.tenantId);
      const failureCount = await deps.settingsRepo.incrementScheduleFailures(settings.tenantId);
      if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
        await deps.settingsRepo.disableSchedule(settings.tenantId);
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Schedule auto-topup unexpected error", { tenantId: settings.tenantId, error: msg });
      result.errors.push(`${settings.tenantId}: ${msg}`);
      result.failed.push(settings.tenantId);
    }
  }

  return result;
}
