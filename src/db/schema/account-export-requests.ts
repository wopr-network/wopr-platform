import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Account export requests — tracks GDPR Article 15 data export requests.
 *
 * States: pending -> processing -> completed | failed
 */
export const accountExportRequests = pgTable(
  "account_export_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    /** pending | processing | completed | failed */
    status: text("status").notNull().default("pending"),
    /** Export format — "json" by default */
    format: text("format").notNull().default("json"),
    /** Signed URL to download the export archive (set on completion) */
    downloadUrl: text("download_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_acct_export_tenant").on(table.tenantId), index("idx_acct_export_status").on(table.status)],
);
