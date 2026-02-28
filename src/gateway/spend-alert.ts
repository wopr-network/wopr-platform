/**
 * Spend alert threshold check — fires at-most-once per billing period
 * when a tenant's monthly spend crosses their configured alertAt value.
 */

import { logger } from "../config/logger.js";
import type { IBillingEmailRepository } from "../email/drizzle-billing-email-repository.js";
import type { ISpendingLimitsRepository } from "../monetization/drizzle-spending-limits-repository.js";
import type { ISpendingCapStore } from "./spending-cap-store.js";

export interface SpendAlertDeps {
  spendingLimitsRepo: ISpendingLimitsRepository;
  spendingCapStore: ISpendingCapStore;
  billingEmailRepo: IBillingEmailRepository;
  notificationService: {
    notifySpendThresholdAlert(
      tenantId: string,
      email: string,
      currentSpendDollars: string,
      alertAtDollars: string,
    ): void;
  };
  resolveEmail: (tenantId: string) => Promise<string | null>;
}

/**
 * Check if a tenant's monthly spend has crossed their alertAt threshold.
 * Fire-and-forget — never throws.
 */
export async function checkSpendAlert(deps: SpendAlertDeps, tenantId: string): Promise<void> {
  try {
    const limits = await deps.spendingLimitsRepo.get(tenantId);
    const alertAt = limits.global.alertAt;
    if (alertAt === null) return;

    const spend = await deps.spendingCapStore.querySpend(tenantId, Date.now());
    if (spend.monthlySpend < alertAt) return;

    // Dedup: max 1 spend-alert per tenant per day (resets each calendar day,
    // and each calendar month resets the monthly spend counter).
    const shouldSend = await deps.billingEmailRepo.shouldSend(tenantId, "spend-alert");
    if (!shouldSend) return;

    const email = await deps.resolveEmail(tenantId);
    if (!email) return;

    await deps.billingEmailRepo.recordSent(tenantId, "spend-alert");
    deps.notificationService.notifySpendThresholdAlert(
      tenantId,
      email,
      `$${spend.monthlySpend.toFixed(2)}`,
      `$${alertAt.toFixed(2)}`,
    );
  } catch (err) {
    logger.error("checkSpendAlert failed", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
