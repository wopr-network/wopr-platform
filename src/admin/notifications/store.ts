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
  enqueue(input: NotificationInput): Promise<NotificationRow>;
  getPending(limit?: number): Promise<NotificationRow[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  countByStatus(): Promise<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

export class DrizzleAdminNotificationQueueStore implements IAdminNotificationQueueStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Enqueue a notification. */
  async enqueue(input: NotificationInput): Promise<NotificationRow> {
    const id = crypto.randomUUID();
    await this.db.insert(notificationQueue).values({
      id,
      tenantId: input.tenantId,
      emailType: input.emailType,
      recipientEmail: input.recipientEmail,
      payload: JSON.stringify(input.payload ?? {}),
      maxAttempts: input.maxAttempts ?? 3,
    });

    const rows = await this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id));
    return rows[0] as NotificationRow;
  }

  /** Get pending notifications ready for sending. */
  async getPending(limit = 10): Promise<NotificationRow[]> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.status, "pending"),
          or(isNull(notificationQueue.retryAfter), lte(notificationQueue.retryAfter, now)),
        ),
      )
      .limit(limit);
    return rows as NotificationRow[];
  }

  /** Mark a notification as sent. */
  async markSent(id: string): Promise<void> {
    const rows = await this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id));
    const row = rows[0];
    if (!row) return;

    const now = Date.now();
    await this.db
      .update(notificationQueue)
      .set({
        status: "sent",
        sentAt: now,
        lastAttemptAt: now,
        attempts: row.attempts + 1,
      })
      .where(eq(notificationQueue.id, id));
  }

  /** Mark a notification as failed with retry logic. */
  async markFailed(id: string, error: string): Promise<void> {
    const rows = await this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id));
    const row = rows[0];
    if (!row) return;

    const now = Date.now();
    const newAttempts = row.attempts + 1;
    const isDeadLetter = newAttempts >= row.maxAttempts;

    // Exponential backoff: 1min, 4min, 16min, ...
    const backoffMinutes = 4 ** (newAttempts - 1);
    const retryAfter = isDeadLetter ? null : now + backoffMinutes * 60 * 1000;

    await this.db
      .update(notificationQueue)
      .set({
        status: isDeadLetter ? "dead_letter" : "failed",
        attempts: newAttempts,
        lastAttemptAt: now,
        lastError: error,
        retryAfter,
      })
      .where(eq(notificationQueue.id, id));
  }

  /** Count notifications by status. */
  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        status: notificationQueue.status,
        count: count(),
      })
      .from(notificationQueue)
      .groupBy(notificationQueue.status);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }
}

/** @deprecated Use DrizzleAdminNotificationQueueStore directly. */
export { DrizzleAdminNotificationQueueStore as NotificationQueueStore };
