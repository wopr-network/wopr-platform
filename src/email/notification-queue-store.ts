import crypto from "node:crypto";
import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { notificationQueue } from "../db/schema/notification-queue.js";
import type { NotificationStatus, QueuedNotification } from "./notification-repository-types.js";

// Re-export domain types for backward compat
export type { NotificationStatus, QueuedNotification } from "./notification-repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for the email notification queue. */
export interface INotificationQueueStore {
  enqueue(tenantId: string, template: string, data: Record<string, unknown>): string;
  fetchPending(limit?: number): QueuedNotification[];
  markSent(id: string): void;
  markFailed(id: string, attempts: number): void;
  listForTenant(
    tenantId: string,
    opts?: { limit?: number; offset?: number; status?: NotificationStatus },
  ): { entries: QueuedNotification[]; total: number };
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

export class DrizzleNotificationQueueStore implements INotificationQueueStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Enqueue a notification for async delivery. Returns the new row ID. */
  enqueue(tenantId: string, template: string, data: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    // emailType stores the template name; payload stores the JSON data;
    // recipientEmail is stored inside the payload but also required by schema.
    const recipientEmail = (data.email as string | undefined) ?? "";
    this.db
      .insert(notificationQueue)
      .values({
        id,
        tenantId,
        emailType: template,
        recipientEmail,
        payload: JSON.stringify(data),
        status: "pending",
        attempts: 0,
      })
      .run();
    return id;
  }

  /** Fetch up to `limit` notifications ready to send. */
  fetchPending(limit = 10): QueuedNotification[] {
    const now = Date.now();
    const rows = this.db
      .select()
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.status, "pending"),
          or(sql`${notificationQueue.retryAfter} IS NULL`, lte(notificationQueue.retryAfter, now)),
        ),
      )
      .limit(limit)
      .all();

    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      template: r.emailType,
      data: r.payload,
      status: r.status as NotificationStatus,
      attempts: r.attempts,
      retryAfter: r.retryAfter ?? null,
      sentAt: r.sentAt ?? null,
      createdAt: r.createdAt,
    }));
  }

  /** Mark a notification as sent. */
  markSent(id: string): void {
    this.db
      .update(notificationQueue)
      .set({ status: "sent", sentAt: Date.now() })
      .where(eq(notificationQueue.id, id))
      .run();
  }

  /** Mark a notification as failed with exponential backoff retry. */
  markFailed(id: string, attempts: number): void {
    const maxAttempts = 5;
    const isPermanentFail = attempts >= maxAttempts;
    const backoffMs = Math.min(60_000 * 2 ** attempts, 3_600_000); // max 1 hour
    this.db
      .update(notificationQueue)
      .set({
        status: isPermanentFail ? "failed" : "pending",
        attempts,
        retryAfter: isPermanentFail ? null : Date.now() + backoffMs,
      })
      .where(eq(notificationQueue.id, id))
      .run();
  }

  /** List notifications for a tenant (for admin view). Paginated. */
  listForTenant(
    tenantId: string,
    opts: { limit?: number; offset?: number; status?: NotificationStatus } = {},
  ): { entries: QueuedNotification[]; total: number } {
    const conditions: ReturnType<typeof eq>[] = [eq(notificationQueue.tenantId, tenantId)];
    if (opts.status) {
      conditions.push(eq(notificationQueue.status, opts.status));
    }

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const totalRow = this.db.select({ count: sql<number>`count(*)` }).from(notificationQueue).where(whereClause).get();
    const total = totalRow?.count ?? 0;

    const rows = this.db
      .select()
      .from(notificationQueue)
      .where(whereClause)
      .orderBy(desc(notificationQueue.createdAt))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0)
      .all();

    const entries = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      template: r.emailType,
      data: r.payload,
      status: r.status as NotificationStatus,
      attempts: r.attempts,
      retryAfter: r.retryAfter ?? null,
      sentAt: r.sentAt ?? null,
      createdAt: r.createdAt,
    }));

    return { entries, total };
  }
}

/** @deprecated Use DrizzleNotificationQueueStore directly. */
export { DrizzleNotificationQueueStore as NotificationQueueStore };
