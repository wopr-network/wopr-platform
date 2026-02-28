import { logger } from "../../config/logger.js";
import type { Credit } from "../credit.js";
import type { AutoTopupChargeResult } from "./auto-topup-charge.js";
import { MAX_CONSECUTIVE_FAILURES } from "./auto-topup-charge.js";
import type { IAutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";
import type { ICreditLedger } from "./credit-ledger.js";

export interface UsageTopupDeps {
  settingsRepo: IAutoTopupSettingsRepository;
  creditLedger: ICreditLedger;
  /** Injected charge function (allows mocking in tests). */
  chargeAutoTopup: (tenantId: string, amount: Credit, source: string) => Promise<AutoTopupChargeResult>;
  /** Optional tenant status check. If provided and returns non-null, skip the charge. */
  checkTenantStatus?: (tenantId: string) => Promise<{ error: string; message: string } | null>;
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

  // 1b. Check tenant status (skip banned/suspended accounts)
  if (deps.checkTenantStatus) {
    const statusErr = await deps.checkTenantStatus(tenantId);
    if (statusErr) return;
  }

  // 2. Check balance vs threshold
  const balance = await deps.creditLedger.balance(tenantId);
  if (!balance.lessThan(settings.usageThreshold)) return;

  // 3. Atomic in-flight guard — compare-and-swap prevents duplicate charges
  const acquired = await deps.settingsRepo.tryAcquireUsageInFlight(tenantId);
  if (!acquired) return;

  try {
    // 4. Execute charge
    const result = await deps.chargeAutoTopup(tenantId, settings.usageTopup, "auto_topup_usage");

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
