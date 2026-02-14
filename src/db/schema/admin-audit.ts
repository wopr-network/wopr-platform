import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const adminAuditLog = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_admin_audit_admin").on(table.adminUser, table.createdAt),
    index("idx_admin_audit_tenant").on(table.targetTenant, table.createdAt),
    index("idx_admin_audit_action").on(table.action, table.createdAt),
  ],
);
