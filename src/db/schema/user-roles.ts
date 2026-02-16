import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * User roles — tracks which role a user has in a given tenant.
 * Platform admins have a special sentinel tenant_id ("*").
 */
export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    role: text("role").notNull(),
    grantedBy: text("granted_by"),
    grantedAt: integer("granted_at").notNull(),
  },
  (table) => [index("idx_user_roles_tenant").on(table.tenantId), index("idx_user_roles_role").on(table.role)],
);
