import { sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Account deletion requests — tracks the lifecycle of GDPR deletion requests.
 *
 * States: pending -> completed | cancelled
 *
 * A pending request has a 30-day grace period. After the grace deadline,
 * the deletion cron executes the purge and marks the request completed.
 * Users can cancel a pending request within the grace period.
 */
export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: text("id").primaryKey(),
    /** Tenant / user ID requesting deletion */
    tenantId: text("tenant_id").notNull(),
    /** User ID who initiated the request */
    requestedBy: text("requested_by").notNull(),
    /** pending | completed | cancelled */
    status: text("status").notNull().default("pending"),
    /** ISO timestamp after which deletion should execute */
    deleteAfter: text("delete_after").notNull(),
    /** Reason for cancellation (if cancelled) */
    cancelReason: text("cancel_reason"),
    /** ISO timestamp when purge completed */
    completedAt: text("completed_at"),
    /** JSON summary of what was deleted (table row counts) */
    deletionSummary: text("deletion_summary"),
    createdAt: text("created_at").notNull().default(sql`(now())`),
    updatedAt: text("updated_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_acct_del_tenant").on(table.tenantId),
    index("idx_acct_del_status").on(table.status),
    index("idx_acct_del_delete_after").on(table.status, table.deleteAfter),
  ],
);
