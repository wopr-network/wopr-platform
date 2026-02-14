import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";

/** Flat retention period in days. */
const RETENTION_DAYS = 30;

/** Get retention period in days. */
export function getRetentionDays(): number {
  return RETENTION_DAYS;
}

/** Delete audit log entries older than the retention period. Returns the number of deleted rows. */
export function purgeExpiredEntries(db: DrizzleDb): number {
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  const result = db.delete(auditLog).where(lt(auditLog.timestamp, cutoff)).run();
  return result.changes;
}

/** Delete audit log entries for a specific user older than the retention period. Returns the number of deleted rows. */
export function purgeExpiredEntriesForUser(db: DrizzleDb, userId: string): number {
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  const result = db
    .delete(auditLog)
    .where(and(eq(auditLog.userId, userId), lt(auditLog.timestamp, cutoff)))
    .run();
  return result.changes;
}
