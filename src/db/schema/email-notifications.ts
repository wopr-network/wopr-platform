import { sql } from "drizzle-orm";
import { index, pgTable, text, unique } from "drizzle-orm/pg-core";

/**
 * Email notification deduplication table.
 *
 * Tracks which billing emails have been sent to prevent duplicates.
 * Unique constraint on (tenantId, emailType, sentDate) ensures max 1
 * email per type per day per tenant.
 */
export const emailNotifications = pgTable(
  "email_notifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    emailType: text("email_type").notNull(),
    sentAt: text("sent_at").notNull().default(sql`(now())`),
    /** Date string (YYYY-MM-DD) extracted from sentAt for dedup constraint. */
    sentDate: text("sent_date").notNull(),
  },
  (table) => [
    unique("uniq_email_per_day").on(table.tenantId, table.emailType, table.sentDate),
    index("idx_email_notif_tenant").on(table.tenantId),
    index("idx_email_notif_type").on(table.emailType),
  ],
);
