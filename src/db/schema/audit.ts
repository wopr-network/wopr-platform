import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    timestamp: integer("timestamp").notNull(),
    userId: text("user_id").notNull(),
    authMethod: text("auth_method").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    details: text("details"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("idx_audit_timestamp").on(table.timestamp),
    index("idx_audit_user_id").on(table.userId),
    index("idx_audit_action").on(table.action),
    index("idx_audit_resource").on(table.resourceType, table.resourceId),
  ],
);
