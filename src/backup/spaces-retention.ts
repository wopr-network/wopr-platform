import { logger } from "../config/logger.js";
import type { SpacesClient, SpacesObject } from "./spaces-client.js";

/**
 * Retention policy for DO Spaces nightly backups.
 *
 * Policy:
 * - Keep last 7 daily snapshots
 * - Keep last 4 weekly snapshots (one per week, preferring the most recent day)
 * - Delete everything older
 *
 * Weekly snapshots are identified as the latest backup in each ISO week.
 */

export interface RetentionConfig {
  /** Number of daily backups to keep (default: 7) */
  dailyCount: number;
  /** Number of weekly backups to keep (default: 4) */
  weeklyCount: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  dailyCount: 7,
  weeklyCount: 4,
};

export interface RetentionResult {
  kept: string[];
  deleted: string[];
  errors: string[];
}

/**
 * Enforce retention policy for a single container's backups in DO Spaces.
 *
 * @param spaces - DO Spaces client
 * @param prefix - S3 prefix for this container's backups (e.g. "nightly/node-1/tenant_abc/")
 * @param config - Retention configuration
 * @param now - Current date (injectable for testing)
 */
export async function enforceSpacesRetention(
  spaces: SpacesClient,
  prefix: string,
  config: RetentionConfig = DEFAULT_RETENTION,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const objects = await spaces.list(prefix);
  if (objects.length === 0) {
    return { kept: [], deleted: [], errors: [] };
  }

  // Sort by date descending (newest first)
  const sorted = [...objects].sort((a, b) => b.date.localeCompare(a.date));

  const toKeep = selectRetained(sorted, config, now);
  const keepSet = new Set(toKeep.map((o) => o.path));

  const toDelete = sorted.filter((o) => !keepSet.has(o.path));
  const kept = sorted.filter((o) => keepSet.has(o.path)).map((o) => o.path);
  const deleted: string[] = [];
  const errors: string[] = [];

  if (toDelete.length > 0) {
    try {
      await spaces.removeMany(toDelete.map((o) => o.path));
      deleted.push(...toDelete.map((o) => o.path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      logger.error(`Retention cleanup failed for ${prefix}`, { err: message });
    }
  }

  logger.info(`Retention for ${prefix}: kept=${kept.length}, deleted=${deleted.length}`);

  return { kept, deleted, errors };
}

/**
 * Select which objects to retain based on daily + weekly policy.
 *
 * 1. Keep the N most recent backups (daily)
 * 2. From older backups, keep one per ISO week (weekly) for M weeks
 */
export function selectRetained(sorted: SpacesObject[], config: RetentionConfig, _now: Date): SpacesObject[] {
  const retained = new Map<string, SpacesObject>();

  // Phase 1: Keep the most recent `dailyCount` backups
  for (let i = 0; i < Math.min(config.dailyCount, sorted.length); i++) {
    retained.set(sorted[i].path, sorted[i]);
  }

  // Phase 2: From remaining, keep one per ISO week for `weeklyCount` weeks
  const remaining = sorted.filter((o) => !retained.has(o.path));
  const weekBuckets = new Map<string, SpacesObject>();

  for (const obj of remaining) {
    const weekKey = getISOWeekKey(new Date(obj.date));
    // Keep the most recent backup per week (sorted is newest-first)
    if (!weekBuckets.has(weekKey)) {
      weekBuckets.set(weekKey, obj);
    }
  }

  // Sort weeks descending, keep only the most recent `weeklyCount`
  const weekKeys = [...weekBuckets.keys()].sort().reverse();
  for (let i = 0; i < Math.min(config.weeklyCount, weekKeys.length); i++) {
    const obj = weekBuckets.get(weekKeys[i]);
    if (obj) retained.set(obj.path, obj);
  }

  return [...retained.values()];
}

/** Return "YYYY-WNN" ISO week key for a date. Uses the ISO 8601 week date definition. */
export function getISOWeekKey(d: Date): string {
  // Work entirely in UTC to avoid timezone issues
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO week starts on Monday. Set to nearest Thursday (current date + 4 - dayOfWeek),
  // with Sunday (0) mapped to 7.
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  // ISO year is the year of the Thursday
  const isoYear = date.getUTCFullYear();
  // Week 1 contains Jan 4, so find Jan 1 of the ISO year and compute offset
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const weekNum = Math.ceil(((date.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}
