import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Tenant account status — tracks the lifecycle state of each tenant.
 *
 * States: active | grace_period | suspended | banned
 *
 * - active: Normal operation, everything works.
 * - grace_period: Credits ran out for monthly products. 3-day window to top up.
 * - suspended: Admin manually suspended OR grace period expired. Agents stop.
 * - banned: Permanent TOS violation. Login disabled. Data queued for deletion.
 */
export const tenantStatus = sqliteTable(
  "tenant_status",
  {
    tenantId: text("tenant_id").primaryKey(),
    status: text("status").notNull().default("active"),
    statusReason: text("status_reason"),
    statusChangedAt: integer("status_changed_at"),
    statusChangedBy: text("status_changed_by"),
    /** ISO timestamp for auto-transition from grace_period to suspended */
    graceDeadline: text("grace_deadline"),
    /** ISO timestamp for data deletion (banned accounts, 30 days after ban) */
    dataDeleteAfter: text("data_delete_after"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_tenant_status_status").on(table.status),
    index("idx_tenant_status_grace").on(table.graceDeadline),
    index("idx_tenant_status_delete").on(table.dataDeleteAfter),
  ],
);
