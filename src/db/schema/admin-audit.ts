import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    adminUser: text("admin_user").notNull(),
    action: text("action").notNull(),
    category: text("category").notNull(),
    targetTenant: text("target_tenant"),
    targetUser: text("target_user"),
    details: text("details").notNull().default("{}"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
    outcome: text("outcome"),
  },
  (table) => [
    index("idx_admin_audit_admin").on(table.adminUser, table.createdAt),
    index("idx_admin_audit_tenant").on(table.targetTenant, table.createdAt),
    index("idx_admin_audit_action").on(table.action, table.createdAt),
  ],
);
