import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Per-tenant security settings.
 *
 * Currently stores the 2FA mandate: when `requireTwoFactor` is true,
 * all users in the tenant must have 2FA enabled before they can access
 * protected resources.
 */
export const tenantSecuritySettings = sqliteTable("tenant_security_settings", {
  tenantId: text("tenant_id").primaryKey(),
  requireTwoFactor: integer("require_two_factor", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
});
