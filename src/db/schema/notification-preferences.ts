import { sql } from "drizzle-orm";
import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Per-tenant notification preferences.
 * Each row is a tenant with boolean flags for each notification category.
 * Absent row = all defaults (everything enabled except agentStatusChanges).
 */
export const notificationPreferences = pgTable("notification_preferences", {
  tenantId: text("tenant_id").primaryKey(),
  billingLowBalance: integer("billing_low_balance").notNull().default(1),
  billingReceipts: integer("billing_receipts").notNull().default(1),
  billingAutoTopup: integer("billing_auto_topup").notNull().default(1),
  agentChannelDisconnect: integer("agent_channel_disconnect").notNull().default(1),
  agentStatusChanges: integer("agent_status_changes").notNull().default(0),
  accountRoleChanges: integer("account_role_changes").notNull().default(1),
  accountTeamInvites: integer("account_team_invites").notNull().default(1),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
});
