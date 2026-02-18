import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Notification queue — queues system emails with retry support.
 *
 * Types: low_balance, grace_entered, suspended, receipt, welcome, reactivated
 * States: pending -> sent | failed | dead_letter
 */
export const notificationQueue = sqliteTable(
  "notification_queue",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    emailType: text("email_type").notNull(),
    /** Recipient email address */
    recipientEmail: text("recipient_email").notNull(),
    /** JSON payload for the email template */
    payload: text("payload").notNull().default("{}"),
    /** pending | sent | failed | dead_letter */
    status: text("status").notNull().default("pending"),
    /** Number of send attempts */
    attempts: integer("attempts").notNull().default(0),
    /** Max retry attempts before dead-lettering */
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** ISO timestamp of last attempt */
    lastAttemptAt: text("last_attempt_at"),
    /** Error message from last failed attempt */
    lastError: text("last_error"),
    /** When to next retry (ISO timestamp). Null = immediately eligible. */
    retryAfter: text("retry_after"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    sentAt: text("sent_at"),
  },
  (table) => [
    index("idx_notif_queue_tenant").on(table.tenantId),
    index("idx_notif_queue_status").on(table.status),
    index("idx_notif_queue_type").on(table.emailType),
    index("idx_notif_queue_retry").on(table.status, table.retryAfter),
  ],
);
