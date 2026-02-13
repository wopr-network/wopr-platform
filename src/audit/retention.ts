import type Database from "better-sqlite3";

/** Tier names matching the monetization tier system. */
export type Tier = "free" | "pro" | "team" | "enterprise";

/** Retention period in days per tier. */
const RETENTION_DAYS: Record<Tier, number> = {
  free: 7,
  pro: 30,
  team: 90,
  enterprise: 365,
};

/** Get retention period in days for a tier. */
export function getRetentionDays(tier: Tier): number {
  return RETENTION_DAYS[tier];
}

/** Delete audit log entries older than the retention period for the given tier. Returns the number of deleted rows. */
export function purgeExpiredEntries(db: Database.Database, tier: Tier): number {
  const retentionMs = RETENTION_DAYS[tier] * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  const result = db.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(cutoff);
  return result.changes;
}

/** Delete audit log entries for a specific user older than the retention period. Returns the number of deleted rows. */
export function purgeExpiredEntriesForUser(db: Database.Database, userId: string, tier: Tier): number {
  const retentionMs = RETENTION_DAYS[tier] * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  const result = db.prepare("DELETE FROM audit_log WHERE user_id = ? AND timestamp < ?").run(userId, cutoff);
  return result.changes;
}
