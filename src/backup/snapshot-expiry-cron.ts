import { logger } from "../config/logger.js";
import type { SnapshotManager } from "./snapshot-manager.js";

export interface SnapshotExpiryCronResult {
  expired: number;
  errors: string[];
}

/**
 * Delete snapshots that have passed their expiresAt timestamp.
 * Runs on a schedule (daily is sufficient).
 */
export async function runSnapshotExpiryCron(manager: SnapshotManager): Promise<SnapshotExpiryCronResult> {
  const result: SnapshotExpiryCronResult = { expired: 0, errors: [] };
  const now = Date.now();

  const expired = await manager.listExpired(now);

  for (const snap of expired) {
    try {
      await manager.hardDelete(snap.id);
      result.expired++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to expire snapshot ${snap.id}`, { error: msg });
      result.errors.push(`${snap.id}: ${msg}`);
    }
  }

  logger.info(`Snapshot expiry cron: expired ${result.expired} snapshots`);
  return result;
}
