import { logger } from "../config/logger.js";
import type { SnapshotManager } from "./snapshot-manager.js";
import type { Tier } from "./types.js";
import { RETENTION_POLICIES } from "./types.js";

/**
 * Enforce retention policy for an instance: delete oldest snapshots
 * that exceed the tier's max snapshot count.
 *
 * @returns number of snapshots deleted
 */
export async function enforceRetention(manager: SnapshotManager, instanceId: string, tier: Tier): Promise<number> {
  const policy = RETENTION_POLICIES[tier];
  const currentCount = manager.count(instanceId);

  if (currentCount <= policy.maxSnapshots) {
    return 0;
  }

  const excess = currentCount - policy.maxSnapshots;
  const toDelete = manager.getOldest(instanceId, excess);

  let deleted = 0;
  for (const snapshot of toDelete) {
    const ok = await manager.delete(snapshot.id);
    if (ok) deleted++;
  }

  if (deleted > 0) {
    logger.info(`Retention: deleted ${deleted} old snapshot(s) for instance ${instanceId} (tier=${tier})`);
  }

  return deleted;
}
