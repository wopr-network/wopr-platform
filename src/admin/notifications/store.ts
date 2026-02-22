import crypto from "node:crypto";
import { and, count, eq, isNull, lte, or } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { notificationQueue } from "../../db/schema/index.js";
import type { NotificationInput, NotificationRow } from "../../email/notification-repository-types.js";

// Re-export domain types for backward compat
export type {
  NotificationEmailType,
  NotificationInput,
  NotificationRow,
} from "../../email/notification-repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for the admin notification queue. */
export interface IAdminNotificationQueueStore {
  enqueue(input: NotificationInput): NotificationRow;
  getPending(limit?: number): NotificationRow[];
  markSent(id: string): void;
  markFailed(id: string, error: string): void;
  countByStatus(): Record<string, number>;
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

export class DrizzleAdminNotificationQueueStore implements IAdminNotificationQueueStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Enqueue a notification. */
  enqueue(input: NotificationInput): NotificationRow {
    const id = crypto.randomUUID();
    this.db
      .insert(notificationQueue)
      .values({
        id,
        tenantId: input.tenantId,
        emailType: input.emailType,
        recipientEmail: input.recipientEmail,
        payload: JSON.stringify(input.payload ?? {}),
        maxAttempts: input.maxAttempts ?? 3,
      })
      .run();

    return this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id)).get() as NotificationRow;
  }

  /** Get pending notifications ready for sending. */
  getPending(limit = 10): NotificationRow[] {
    const now = Date.now();
    return this.db
      .select()
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.status, "pending"),
          or(isNull(notificationQueue.retryAfter), lte(notificationQueue.retryAfter, now)),
        ),
      )
      .limit(limit)
      .all() as NotificationRow[];
  }

  /** Mark a notification as sent. */
  markSent(id: string): void {
    const row = this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id)).get();

    if (!row) return;

    const now = Date.now();
    this.db
      .update(notificationQueue)
      .set({
        status: "sent",
        sentAt: now,
        lastAttemptAt: now,
        attempts: row.attempts + 1,
      })
      .where(eq(notificationQueue.id, id))
      .run();
  }

  /** Mark a notification as failed with retry logic. */
  markFailed(id: string, error: string): void {
    const row = this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id)).get();

    if (!row) return;

    const now = Date.now();
    const newAttempts = row.attempts + 1;
    const isDeadLetter = newAttempts >= row.maxAttempts;

    // Exponential backoff: 1min, 4min, 16min, ...
    const backoffMinutes = 4 ** (newAttempts - 1);
    const retryAfter = isDeadLetter ? null : now + backoffMinutes * 60 * 1000;

    this.db
      .update(notificationQueue)
      .set({
        status: isDeadLetter ? "dead_letter" : "failed",
        attempts: newAttempts,
        lastAttemptAt: now,
        lastError: error,
        retryAfter,
      })
      .where(eq(notificationQueue.id, id))
      .run();
  }

  /** Count notifications by status. */
  countByStatus(): Record<string, number> {
    const rows = this.db
      .select({
        status: notificationQueue.status,
        count: count(),
      })
      .from(notificationQueue)
      .groupBy(notificationQueue.status)
      .all();

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }
}

/** @deprecated Use DrizzleAdminNotificationQueueStore directly. */
export { DrizzleAdminNotificationQueueStore as NotificationQueueStore };
