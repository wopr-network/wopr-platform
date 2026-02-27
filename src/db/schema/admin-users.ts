import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const adminUsers = pgTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    tenantId: text("tenant_id").notNull(),
    status: text("status").notNull().default("active"),
    role: text("role").notNull().default("user"),
    creditBalanceCredits: integer("credit_balance_credits").notNull().default(0),
    agentCount: integer("agent_count").notNull().default(0),
    lastSeen: bigint("last_seen", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_admin_users_email").on(table.email),
    index("idx_admin_users_tenant").on(table.tenantId),
    index("idx_admin_users_status").on(table.status),
    index("idx_admin_users_role").on(table.role),
    index("idx_admin_users_created").on(table.createdAt),
    index("idx_admin_users_last_seen").on(table.lastSeen),
    check(
      "chk_admin_users_status",
      sql`${table.status} IN ('active', 'suspended', 'grace_period', 'dormant', 'banned')`,
    ),
    check("chk_admin_users_role", sql`${table.role} IN ('platform_admin', 'tenant_admin', 'user')`),
  ],
);
