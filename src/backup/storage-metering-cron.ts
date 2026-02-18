import { logger } from "../config/logger.js";
import type { MeterEmitter } from "../monetization/metering/emitter.js";
import type { SnapshotManager } from "./snapshot-manager.js";
import { STORAGE_CHARGE_PER_GB_MONTH, STORAGE_COST_PER_GB_MONTH } from "./types.js";

export interface StorageMeteringCronConfig {
  manager: SnapshotManager;
  meterEmitter: MeterEmitter;
}

export interface StorageMeteringResult {
  tenantsProcessed: number;
  snapshotsCounted: number;
  totalSizeGb: number;
  totalCharge: number;
  errors: string[];
}

/**
 * Run monthly storage metering for all retained on-demand snapshots.
 *
 * Iterates all non-deleted on-demand snapshots, groups by tenant,
 * and emits a metering event per tenant for their total storage.
 */
export async function runStorageMeteringCron(cfg: StorageMeteringCronConfig): Promise<StorageMeteringResult> {
  const result: StorageMeteringResult = {
    tenantsProcessed: 0,
    snapshotsCounted: 0,
    totalSizeGb: 0,
    totalCharge: 0,
    errors: [],
  };

  // Get all active on-demand snapshots
  const activeSnapshots = cfg.manager.listAllActive("on-demand");

  // Group by tenant
  const tenantSizes = new Map<string, number>(); // tenant -> total bytes
  for (const snap of activeSnapshots) {
    const bytes = snap.sizeBytes ?? Math.round(snap.sizeMb * 1024 * 1024);
    tenantSizes.set(snap.tenant, (tenantSizes.get(snap.tenant) ?? 0) + bytes);
    result.snapshotsCounted++;
  }

  for (const [tenant, totalBytes] of tenantSizes) {
    try {
      const sizeGb = totalBytes / (1024 * 1024 * 1024);
      result.totalSizeGb += sizeGb;

      const cost = sizeGb * STORAGE_COST_PER_GB_MONTH;
      const charge = sizeGb * STORAGE_CHARGE_PER_GB_MONTH;
      result.totalCharge += charge;

      cfg.meterEmitter.emit({
        tenant,
        cost,
        charge,
        capability: "storage",
        provider: "do-spaces",
        timestamp: Date.now(),
        metadata: {
          type: "monthly-storage",
          totalBytes,
          snapshotCount: activeSnapshots.filter((s) => s.tenant === tenant).length,
        },
      });

      result.tenantsProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Storage metering failed for tenant ${tenant}`, { error: msg });
      result.errors.push(`${tenant}: ${msg}`);
    }
  }

  logger.info(
    `Storage metering complete: ${result.tenantsProcessed} tenants, ${result.snapshotsCounted} snapshots, ${result.totalSizeGb.toFixed(4)} GB`,
  );
  return result;
}
