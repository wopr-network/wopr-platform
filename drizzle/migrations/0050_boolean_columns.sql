-- Replace integer boolean columns with native PostgreSQL boolean type (WOP-1052)
-- Each DO block is idempotent: only runs if the column is not already boolean.
-- DROP DEFAULT / ALTER TYPE / SET DEFAULT sequence is required because
-- PostgreSQL cannot cast an integer DEFAULT expression to boolean automatically.

-- admin_notes: is_pinned (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admin_notes' AND column_name = 'is_pinned' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "admin_notes" ALTER COLUMN "is_pinned" DROP DEFAULT;
    ALTER TABLE "admin_notes" ALTER COLUMN "is_pinned" SET DATA TYPE boolean USING (is_pinned::boolean);
    ALTER TABLE "admin_notes" ALTER COLUMN "is_pinned" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- bulk_undo_grants: undone (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bulk_undo_grants' AND column_name = 'undone' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "bulk_undo_grants" ALTER COLUMN "undone" DROP DEFAULT;
    ALTER TABLE "bulk_undo_grants" ALTER COLUMN "undone" SET DATA TYPE boolean USING (undone::boolean);
    ALTER TABLE "bulk_undo_grants" ALTER COLUMN "undone" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- credit_auto_topup_settings: usage_enabled (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_auto_topup_settings' AND column_name = 'usage_enabled' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_enabled" DROP DEFAULT;
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_enabled" SET DATA TYPE boolean USING (usage_enabled::boolean);
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_enabled" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- credit_auto_topup_settings: usage_charge_in_flight (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_auto_topup_settings' AND column_name = 'usage_charge_in_flight' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_charge_in_flight" DROP DEFAULT;
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_charge_in_flight" SET DATA TYPE boolean USING (usage_charge_in_flight::boolean);
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "usage_charge_in_flight" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- credit_auto_topup_settings: schedule_enabled (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_auto_topup_settings' AND column_name = 'schedule_enabled' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "schedule_enabled" DROP DEFAULT;
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "schedule_enabled" SET DATA TYPE boolean USING (schedule_enabled::boolean);
    ALTER TABLE "credit_auto_topup_settings" ALTER COLUMN "schedule_enabled" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- fleet_events: fired (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fleet_events' AND column_name = 'fired' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "fleet_events" ALTER COLUMN "fired" DROP DEFAULT;
    ALTER TABLE "fleet_events" ALTER COLUMN "fired" SET DATA TYPE boolean USING (fired::boolean);
    ALTER TABLE "fleet_events" ALTER COLUMN "fired" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- marketplace_plugins: enabled (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'marketplace_plugins' AND column_name = 'enabled' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "marketplace_plugins" ALTER COLUMN "enabled" DROP DEFAULT;
    ALTER TABLE "marketplace_plugins" ALTER COLUMN "enabled" SET DATA TYPE boolean USING (enabled::boolean);
    ALTER TABLE "marketplace_plugins" ALTER COLUMN "enabled" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- marketplace_plugins: featured (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'marketplace_plugins' AND column_name = 'featured' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "marketplace_plugins" ALTER COLUMN "featured" DROP DEFAULT;
    ALTER TABLE "marketplace_plugins" ALTER COLUMN "featured" SET DATA TYPE boolean USING (featured::boolean);
    ALTER TABLE "marketplace_plugins" ALTER COLUMN "featured" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: billing_low_balance (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'billing_low_balance' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_low_balance" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_low_balance" SET DATA TYPE boolean USING (billing_low_balance::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_low_balance" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: billing_receipts (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'billing_receipts' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_receipts" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_receipts" SET DATA TYPE boolean USING (billing_receipts::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_receipts" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: billing_auto_topup (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'billing_auto_topup' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_auto_topup" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_auto_topup" SET DATA TYPE boolean USING (billing_auto_topup::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "billing_auto_topup" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: agent_channel_disconnect (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'agent_channel_disconnect' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "agent_channel_disconnect" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "agent_channel_disconnect" SET DATA TYPE boolean USING (agent_channel_disconnect::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "agent_channel_disconnect" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: agent_status_changes (default false)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'agent_status_changes' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "agent_status_changes" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "agent_status_changes" SET DATA TYPE boolean USING (agent_status_changes::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "agent_status_changes" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: account_role_changes (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'account_role_changes' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "account_role_changes" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "account_role_changes" SET DATA TYPE boolean USING (account_role_changes::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "account_role_changes" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- notification_preferences: account_team_invites (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_preferences' AND column_name = 'account_team_invites' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "notification_preferences" ALTER COLUMN "account_team_invites" DROP DEFAULT;
    ALTER TABLE "notification_preferences" ALTER COLUMN "account_team_invites" SET DATA TYPE boolean USING (account_team_invites::boolean);
    ALTER TABLE "notification_preferences" ALTER COLUMN "account_team_invites" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- provider_credentials: is_active (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_credentials' AND column_name = 'is_active' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "provider_credentials" ALTER COLUMN "is_active" DROP DEFAULT;
    ALTER TABLE "provider_credentials" ALTER COLUMN "is_active" SET DATA TYPE boolean USING (is_active::boolean);
    ALTER TABLE "provider_credentials" ALTER COLUMN "is_active" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- provider_costs: is_active (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_costs' AND column_name = 'is_active' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "provider_costs" ALTER COLUMN "is_active" DROP DEFAULT;
    ALTER TABLE "provider_costs" ALTER COLUMN "is_active" SET DATA TYPE boolean USING (is_active::boolean);
    ALTER TABLE "provider_costs" ALTER COLUMN "is_active" SET DEFAULT true;
  END IF;
END $$;
--> statement-breakpoint
-- sell_rates: is_active (default true)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sell_rates' AND column_name = 'is_active' AND data_type != 'boolean'
  ) THEN
    ALTER TABLE "sell_rates" ALTER COLUMN "is_active" DROP DEFAULT;
    ALTER TABLE "sell_rates" ALTER COLUMN "is_active" SET DATA TYPE boolean USING (is_active::boolean);
    ALTER TABLE "sell_rates" ALTER COLUMN "is_active" SET DEFAULT true;
  END IF;
END $$;
