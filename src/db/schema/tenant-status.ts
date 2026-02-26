import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

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
export const tenantStatus = pgTable(
  "tenant_status",
  {
    tenantId: text("tenant_id").primaryKey(),
    status: text("status").notNull().default("active"),
    statusReason: text("status_reason"),
    statusChangedAt: bigint("status_changed_at", { mode: "number" }),
    statusChangedBy: text("status_changed_by"),
    /** ISO timestamp for auto-transition from grace_period to suspended */
    graceDeadline: text("grace_deadline"),
    /** ISO timestamp for data deletion (banned accounts, 30 days after ban) */
    dataDeleteAfter: text("data_delete_after"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
  },
  (table) => [
    index("idx_tenant_status_status").on(table.status),
    index("idx_tenant_status_grace").on(table.graceDeadline),
    index("idx_tenant_status_delete").on(table.dataDeleteAfter),
  ],
);
