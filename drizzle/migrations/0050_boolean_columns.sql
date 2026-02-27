-- Replace integer boolean columns with native PostgreSQL boolean type (WOP-1052)

-- admin_notes: is_pinned
ALTER TABLE "admin_notes" ALTER COLUMN "is_pinned" SET DATA TYPE boolean USING (is_pinned::boolean);

-- bulk_undo_grants: undone
ALTER TABLE "bulk_undo_grants" ALTER COLUMN "undone" SET DATA TYPE boolean USING (undone::boolean);

-- credit_auto_topup_settings: usage_enabled, usage_charge_in_flight, schedule_enabled
ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_enabled" SET DATA TYPE boolean USING (usage_enabled::boolean);
ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_charge_in_flight" SET DATA TYPE boolean USING (usage_charge_in_flight::boolean);
ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "schedule_enabled" SET DATA TYPE boolean USING (schedule_enabled::boolean);

-- fleet_events: fired
ALTER TABLE "fleet_events" ALTER COLUMN "fired" SET DATA TYPE boolean USING (fired::boolean);

-- marketplace_plugins: enabled, featured
ALTER TABLE "marketplace_plugins" ALTER COLUMN "enabled" SET DATA TYPE boolean USING (enabled::boolean);
ALTER TABLE "marketplace_plugins" ALTER COLUMN "featured" SET DATA TYPE boolean USING (featured::boolean);

-- notification_preferences: all 7 boolean columns
ALTER TABLE "notification_preferences" ALTER COLUMN "billing_low_balance" SET DATA TYPE boolean USING (billing_low_balance::boolean);
ALTER TABLE "notification_preferences" ALTER COLUMN "billing_receipts" SET DATA TYPE boolean USING (billing_receipts::boolean);
ALTER TABLE "notification_preferences" ALTER COLUMN "billing_auto_topup" SET DATA TYPE boolean USING (billing_auto_topup::boolean);
ALTER TABLE "notification_preferences" ALTER COLUMN "agent_channel_disconnect" SET DATA TYPE boolean USING (agent_channel_disconnect::boolean);
ALTER TABLE "notification_preferences" ALTER COLUMN "agent_status_changes" SET DATA TYPE boolean USING (agent_status_changes::boolean);
ALTER TABLE "notification_preferences" ALTER COLUMN "account_role_changes" SET DATA TYPE boolean USING (account_role_changes::boolean);
ALTER TABLE "notification_preferences" ALTER COLUMN "account_team_invites" SET DATA TYPE boolean USING (account_team_invites::boolean);

-- provider_credentials: is_active
ALTER TABLE "provider_credentials" ALTER COLUMN "is_active" SET DATA TYPE boolean USING (is_active::boolean);

-- provider_costs: is_active
ALTER TABLE "provider_costs" ALTER COLUMN "is_active" SET DATA TYPE boolean USING (is_active::boolean);

-- sell_rates: is_active
ALTER TABLE "sell_rates" ALTER COLUMN "is_active" SET DATA TYPE boolean USING (is_active::boolean);
