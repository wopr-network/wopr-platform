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
  enqueue(tenantId: string, template: string, data: Record<string, unknown>): Promise<string>;
  fetchPending(limit?: number): Promise<QueuedNotification[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, attempts: number): Promise<void>;
  listForTenant(
    tenantId: string,
    opts?: { limit?: number; offset?: number; status?: NotificationStatus },
  ): Promise<{ entries: QueuedNotification[]; total: number }>;
}

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

export class DrizzleNotificationQueueStore implements INotificationQueueStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Enqueue a notification for async delivery. Returns the new row ID. */
  async enqueue(tenantId: string, template: string, data: Record<string, unknown>): Promise<string> {
    const id = crypto.randomUUID();
    const recipientEmail = (data.email as string | undefined) ?? "";
    await this.db.insert(notificationQueue).values({
      id,
      tenantId,
      emailType: template,
      recipientEmail,
      payload: JSON.stringify(data),
      status: "pending",
      attempts: 0,
    });
    return id;
  }

  /** Fetch up to `limit` notifications ready to send. */
  async fetchPending(limit = 10): Promise<QueuedNotification[]> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.status, "pending"),
          or(sql`${notificationQueue.retryAfter} IS NULL`, lte(notificationQueue.retryAfter, now)),
        ),
      )
      .limit(limit);

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
  async markSent(id: string): Promise<void> {
    await this.db
      .update(notificationQueue)
      .set({ status: "sent", sentAt: Date.now() })
      .where(eq(notificationQueue.id, id));
  }

  /** Mark a notification as failed with exponential backoff retry. */
  async markFailed(id: string, attempts: number): Promise<void> {
    const maxAttempts = 5;
    const isPermanentFail = attempts >= maxAttempts;
    const backoffMs = Math.min(60_000 * 2 ** attempts, 3_600_000); // max 1 hour
    await this.db
      .update(notificationQueue)
      .set({
        status: isPermanentFail ? "failed" : "pending",
        attempts,
        retryAfter: isPermanentFail ? null : Date.now() + backoffMs,
      })
      .where(eq(notificationQueue.id, id));
  }

  /** List notifications for a tenant (for admin view). Paginated. */
  async listForTenant(
    tenantId: string,
    opts: { limit?: number; offset?: number; status?: NotificationStatus } = {},
  ): Promise<{ entries: QueuedNotification[]; total: number }> {
    const conditions: ReturnType<typeof eq>[] = [eq(notificationQueue.tenantId, tenantId)];
    if (opts.status) {
      conditions.push(eq(notificationQueue.status, opts.status));
    }

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const totalRows = await this.db.select({ count: sql<number>`count(*)` }).from(notificationQueue).where(whereClause);
    const total = totalRows[0]?.count ?? 0;

    const rows = await this.db
      .select()
      .from(notificationQueue)
      .where(whereClause)
      .orderBy(desc(notificationQueue.createdAt))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);

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
