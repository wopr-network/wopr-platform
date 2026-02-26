import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Per-tenant security settings.
 *
 * Currently stores the 2FA mandate: when `requireTwoFactor` is true,
 * all users in the tenant must have 2FA enabled before they can access
 * protected resources.
 */
export const tenantSecuritySettings = pgTable("tenant_security_settings", {
  tenantId: text("tenant_id").primaryKey(),
  requireTwoFactor: boolean("require_two_factor").notNull().default(false),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
