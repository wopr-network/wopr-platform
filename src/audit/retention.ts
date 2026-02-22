import type { IAuditLogRepository } from "./audit-log-repository.js";

/** Flat retention period in days. */
const RETENTION_DAYS = 30;

/** Get retention period in days. */
export function getRetentionDays(): number {
  return RETENTION_DAYS;
}

/** Delete audit log entries older than the retention period. Returns the number of deleted rows. */
export function purgeExpiredEntries(repo: IAuditLogRepository): number {
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  return repo.purgeOlderThan(cutoff);
}

/** Delete audit log entries for a specific user older than the retention period. Returns the number of deleted rows. */
export function purgeExpiredEntriesForUser(repo: IAuditLogRepository, userId: string): number {
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  return repo.purgeOlderThanForUser(cutoff, userId);
}
