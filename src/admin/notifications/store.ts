import crypto from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { notificationQueue } from "../../db/schema/index.js";

export type NotificationEmailType =
  | "low_balance"
  | "grace_entered"
  | "suspended"
  | "receipt"
  | "welcome"
  | "reactivated";

export interface NotificationInput {
  tenantId: string;
  emailType: NotificationEmailType;
  recipientEmail: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface NotificationRow {
  id: string;
  tenantId: string;
  emailType: string;
  recipientEmail: string;
  payload: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  retryAfter: string | null;
  createdAt: string;
  sentAt: string | null;
}

export class NotificationQueueStore {
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

    return this.db
      .select()
      .from(notificationQueue)
      .where(eq(notificationQueue.id, id))
      .get() as NotificationRow;
  }

  /** Get pending notifications ready for sending. */
  getPending(limit = 10): NotificationRow[] {
    return this.db
      .select()
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.status, "pending"),
          sql`(${notificationQueue.retryAfter} IS NULL OR ${notificationQueue.retryAfter} <= datetime('now'))`,
        ),
      )
      .limit(limit)
      .all() as NotificationRow[];
  }

  /** Mark a notification as sent. */
  markSent(id: string): void {
    this.db
      .update(notificationQueue)
      .set({
        status: "sent",
        sentAt: sql`(datetime('now'))`,
        lastAttemptAt: sql`(datetime('now'))`,
        attempts: sql`${notificationQueue.attempts} + 1`,
      })
      .where(eq(notificationQueue.id, id))
      .run();
  }

  /** Mark a notification as failed with retry logic. */
  markFailed(id: string, error: string): void {
    const row = this.db
      .select()
      .from(notificationQueue)
      .where(eq(notificationQueue.id, id))
      .get();

    if (!row) return;

    const newAttempts = row.attempts + 1;
    const isDeadLetter = newAttempts >= row.maxAttempts;

    // Exponential backoff: 1min, 4min, 16min, ...
    const backoffMinutes = Math.pow(4, newAttempts - 1);
    const retryAfter = isDeadLetter
      ? null
      : sql`(datetime('now', '+${sql.raw(String(backoffMinutes))} minutes'))`;

    this.db
      .update(notificationQueue)
      .set({
        status: isDeadLetter ? "dead_letter" : "failed",
        attempts: newAttempts,
        lastAttemptAt: sql`(datetime('now'))`,
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
