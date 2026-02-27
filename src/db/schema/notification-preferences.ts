import { sql } from "drizzle-orm";
import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Per-tenant notification preferences.
 * Each row is a tenant with boolean flags for each notification category.
 * Absent row = all defaults (everything enabled except agentStatusChanges).
 */
export const notificationPreferences = pgTable("notification_preferences", {
  tenantId: text("tenant_id").primaryKey(),
  billingLowBalance: boolean("billing_low_balance").notNull().default(true),
  billingReceipts: boolean("billing_receipts").notNull().default(true),
  billingAutoTopup: boolean("billing_auto_topup").notNull().default(true),
  agentChannelDisconnect: boolean("agent_channel_disconnect").notNull().default(true),
  agentStatusChanges: boolean("agent_status_changes").notNull().default(false),
  accountRoleChanges: boolean("account_role_changes").notNull().default(true),
  accountTeamInvites: boolean("account_team_invites").notNull().default(true),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
});
