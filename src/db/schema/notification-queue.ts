import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Notification queue — queues system emails with retry support.
 *
 * Types: low_balance, grace_entered, suspended, receipt, welcome, reactivated
 * States: pending -> sent | failed | dead_letter
 *
 * All timestamps are unix epoch milliseconds (integer) to match admin_notes.
 */
export const notificationQueue = pgTable(
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
    /** Unix epoch ms of last attempt */
    lastAttemptAt: bigint("last_attempt_at", { mode: "number" }),
    /** Error message from last failed attempt */
    lastError: text("last_error"),
    /** When to next retry (unix epoch ms). Null = immediately eligible. */
    retryAfter: bigint("retry_after", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
    sentAt: bigint("sent_at", { mode: "number" }),
  },
  (table) => [
    index("idx_notif_queue_tenant").on(table.tenantId),
    index("idx_notif_queue_status").on(table.status),
    index("idx_notif_queue_type").on(table.emailType),
    index("idx_notif_queue_retry").on(table.status, table.retryAfter),
  ],
);
