import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * User role assignments — maps users to roles within tenants.
 *
 * Platform-wide admins use tenant_id = "*" (sentinel value).
 * Roles: platform_admin, tenant_admin, user.
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
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    index("idx_user_roles_tenant").on(table.tenantId),
    index("idx_user_roles_role").on(table.role),
  ],
);
