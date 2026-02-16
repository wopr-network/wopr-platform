import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Admin users table — denormalized view of user data for admin queries.
 * Aggregates data from auth DB + billing DB for dashboard use.
 */
export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    tenantId: text("tenant_id").notNull(),
    status: text("status").notNull().default("active"),
    role: text("role").notNull().default("user"),
    creditBalanceCents: integer("credit_balance_cents").notNull().default(0),
    agentCount: integer("agent_count").notNull().default(0),
    lastSeen: integer("last_seen"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_admin_users_email").on(table.email),
    index("idx_admin_users_tenant").on(table.tenantId),
    index("idx_admin_users_status").on(table.status),
    index("idx_admin_users_role").on(table.role),
    index("idx_admin_users_created").on(table.createdAt),
    index("idx_admin_users_last_seen").on(table.lastSeen),
  ],
);
