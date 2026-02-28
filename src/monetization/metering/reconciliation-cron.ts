import { logger } from "../../config/logger.js";
import { Credit } from "../credit.js";
import type { IAdapterUsageRepository, IUsageSummaryRepository } from "./reconciliation-repository.js";

export interface ReconciliationConfig {
  usageSummaryRepo: IUsageSummaryRepository;
  adapterUsageRepo: IAdapterUsageRepository;
  /** The date to reconcile, as YYYY-MM-DD. Defaults to yesterday. */
  targetDate?: string;
  /** Raw nano-dollar threshold below which drift is ignored. Default: 1 cent in raw units. */
  driftThresholdRaw?: number;
  /** If drift exceeds this raw amount, flag the account for review. Default: $1.00 in raw units. */
  flagThresholdRaw?: number;
  /** Callback invoked for each tenant exceeding the flag threshold. */
  onFlagForReview?: (tenantId: string, driftRaw: number) => void | Promise<void>;
}

export interface ReconciliationResult {
  /** Date reconciled (YYYY-MM-DD). */
  date: string;
  /** Number of tenants checked. */
  tenantsChecked: number;
  /** Tenants with drift exceeding driftThresholdRaw. */
  discrepancies: Array<{
    tenantId: string;
    /** Total charge from metering (raw nano-dollars). */
    meteredChargeRaw: number;
    /** Total debits from ledger for adapter_usage (raw nano-dollars, absolute value). */
    ledgerDebitRaw: number;
    /** meteredChargeRaw - ledgerDebitRaw (positive = under-billed, negative = over-billed). */
    driftRaw: number;
  }>;
  /** Tenants flagged for review (drift > flagThresholdRaw). */
  flagged: string[];
}

/**
 * Reconcile metered usage charges against ledger adapter_usage debits
 * for a single day. Logs warnings for any per-tenant drift exceeding the
 * threshold and optionally flags accounts for review.
 */
export async function runReconciliation(cfg: ReconciliationConfig): Promise<ReconciliationResult> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDate = cfg.targetDate ?? yesterday.toISOString().slice(0, 10);

  const driftThresholdRaw = cfg.driftThresholdRaw ?? Credit.fromCents(1).toRaw();
  const flagThresholdRaw = cfg.flagThresholdRaw ?? Credit.fromCents(100).toRaw();

  // Convert YYYY-MM-DD to epoch ms range [dayStart, dayEnd)
  const dayStart = new Date(`${targetDate}T00:00:00Z`).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const result: ReconciliationResult = {
    date: targetDate,
    tenantsChecked: 0,
    discrepancies: [],
    flagged: [],
  };

  // 1. Sum metered charges per tenant from usage_summaries for the day window.
  //    Filter out __sentinel__ rows.
  const meteredRows = await cfg.usageSummaryRepo.getAggregatedChargesByWindow(dayStart, dayEnd);

  // 2. Sum ledger adapter_usage debits per tenant for the same day.
  //    credit_transactions.created_at is a text column storing Postgres now() values
  //    (e.g. "2026-02-28 17:00:00+00"). Cast to timestamptz for reliable range comparison.
  const dayStartIso = new Date(dayStart).toISOString();
  const dayEndIso = new Date(dayEnd).toISOString();

  const ledgerRows = await cfg.adapterUsageRepo.getAggregatedAdapterUsageDebits(dayStartIso, dayEndIso);

  // 3. Build union of tenant IDs from both sources so ledger-only tenants
  //    (e.g. debits with no metering summary — negative drift / over-billed) are also checked.
  const meteredMap = new Map<string, number>();
  for (const row of meteredRows) {
    meteredMap.set(row.tenant, row.totalChargeRaw);
  }

  const ledgerMap = new Map<string, number>();
  for (const row of ledgerRows) {
    ledgerMap.set(row.tenantId, row.totalDebitRaw);
  }

  const allTenants = new Set([...meteredMap.keys(), ...ledgerMap.keys()]);

  if (allTenants.size === 0) {
    return result;
  }

  // 4. Compare per-tenant across the union
  result.tenantsChecked = allTenants.size;

  for (const tenantId of allTenants) {
    const meteredChargeRaw = meteredMap.get(tenantId) ?? 0;
    const ledgerDebitRaw = ledgerMap.get(tenantId) ?? 0;
    const driftRaw = meteredChargeRaw - ledgerDebitRaw;
    const absDrift = Math.abs(driftRaw);

    if (absDrift > driftThresholdRaw) {
      result.discrepancies.push({
        tenantId,
        meteredChargeRaw,
        ledgerDebitRaw,
        driftRaw,
      });

      logger.warn("Metering/ledger drift detected", {
        tenantId,
        meteredCharge: Credit.fromRaw(meteredChargeRaw).toDisplayString(),
        ledgerDebit: Credit.fromRaw(ledgerDebitRaw).toDisplayString(),
        drift: Credit.fromRaw(absDrift).toDisplayString(),
        direction: driftRaw > 0 ? "under-billed" : "over-billed",
        date: targetDate,
      });

      if (absDrift > flagThresholdRaw) {
        result.flagged.push(tenantId);
        if (cfg.onFlagForReview) {
          try {
            await cfg.onFlagForReview(tenantId, driftRaw);
          } catch (err) {
            logger.error("onFlagForReview callback failed for tenant", {
              tenantId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  }

  return result;
}
