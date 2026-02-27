import { logger } from "../../config/logger.js";
import { Credit } from "../credit.js";
import type { AutoTopupChargeResult } from "./auto-topup-charge.js";
import { MAX_CONSECUTIVE_FAILURES } from "./auto-topup-charge.js";
import type { IAutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";
import type { ICreditLedger } from "./credit-ledger.js";

export interface UsageTopupDeps {
  settingsRepo: IAutoTopupSettingsRepository;
  creditLedger: ICreditLedger;
  /** Injected charge function (allows mocking in tests). */
  chargeAutoTopup: (tenantId: string, amountCents: number, source: string) => Promise<AutoTopupChargeResult>;
}

/**
 * Check whether a usage-based auto-topup should fire for a tenant.
 *
 * Called async after every credit debit. Fire-and-forget -- caller catches errors.
 * Idempotent: skips if a charge is already in-flight for this tenant.
 */
export async function maybeTriggerUsageTopup(deps: UsageTopupDeps, tenantId: string): Promise<void> {
  // 1. Look up settings
  const settings = await deps.settingsRepo.getByTenant(tenantId);
  if (!settings || !settings.usageEnabled) return;

  // 2. Check in-flight guard (idempotency)
  if (settings.usageChargeInFlight) return;

  // 3. Check balance vs threshold
  const balance = await deps.creditLedger.balance(tenantId);
  if (!balance.lessThan(Credit.fromCents(settings.usageThresholdCents))) return;

  // 4. Set in-flight flag
  await deps.settingsRepo.setUsageChargeInFlight(tenantId, true);

  try {
    // 5. Execute charge
    const result = await deps.chargeAutoTopup(tenantId, settings.usageTopupCents, "auto_topup_usage");

    if (result.success) {
      await deps.settingsRepo.resetUsageFailures(tenantId);
    } else {
      const failureCount = await deps.settingsRepo.incrementUsageFailures(tenantId);
      if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
        await deps.settingsRepo.disableUsage(tenantId);
        logger.warn("Usage auto-topup disabled after consecutive failures", { tenantId, failureCount });
      }
    }
  } catch (err) {
    const failureCount = await deps.settingsRepo.incrementUsageFailures(tenantId);
    if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
      await deps.settingsRepo.disableUsage(tenantId);
    }
    logger.error("Usage auto-topup unexpected error", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // 6. Clear in-flight flag
    await deps.settingsRepo.setUsageChargeInFlight(tenantId, false);
  }
}
