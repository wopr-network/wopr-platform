CREATE TABLE "account_deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delete_after" text NOT NULL,
	"cancel_reason" text,
	"completed_at" text,
	"deletion_summary" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_user" text NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"target_tenant" text,
	"target_user" text,
	"details" text DEFAULT '{}' NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "admin_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"is_pinned" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"tenant_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"credit_balance_cents" integer DEFAULT 0 NOT NULL,
	"agent_count" integer DEFAULT 0 NOT NULL,
	"last_seen" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "chk_admin_users_status" CHECK ("admin_users"."status" IN ('active', 'suspended', 'grace_period', 'dormant', 'banned')),
	CONSTRAINT "chk_admin_users_role" CHECK ("admin_users"."role" IN ('platform_admin', 'tenant_admin', 'user'))
);
--> statement-breakpoint
CREATE TABLE "affiliate_codes" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "affiliate_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "affiliate_referrals" (
	"id" text PRIMARY KEY NOT NULL,
	"referrer_tenant_id" text NOT NULL,
	"referred_tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"signed_up_at" text DEFAULT (now()) NOT NULL,
	"first_purchase_at" text,
	"match_amount_cents" integer,
	"matched_at" text,
	CONSTRAINT "affiliate_referrals_referred_tenant_id_unique" UNIQUE("referred_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" bigint NOT NULL,
	"user_id" text NOT NULL,
	"auth_method" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"details" text,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "backup_status" (
	"container_id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"last_backup_at" text,
	"last_backup_size_mb" real,
	"last_backup_path" text,
	"last_backup_success" boolean DEFAULT false NOT NULL,
	"last_backup_error" text,
	"total_backups" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"node_id" text,
	"billing_state" text DEFAULT 'active' NOT NULL,
	"suspended_at" text,
	"destroy_after" text,
	"resource_tier" text DEFAULT 'standard' NOT NULL,
	"storage_tier" text DEFAULT 'standard' NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"env" text DEFAULT '{}' NOT NULL,
	"restart_policy" text DEFAULT 'unless-stopped' NOT NULL,
	"update_policy" text DEFAULT 'on-push' NOT NULL,
	"release_channel" text DEFAULT 'stable' NOT NULL,
	"volume_name" text,
	"discovery_json" text,
	"description" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_undo_grants" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"tenant_ids" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"admin_user" text NOT NULL,
	"created_at" bigint NOT NULL,
	"undo_deadline" bigint NOT NULL,
	"undone" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "circuit_breaker_states" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" bigint NOT NULL,
	"tripped_at" bigint
);
--> statement-breakpoint
CREATE TABLE "credit_auto_topup_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"usage_enabled" integer DEFAULT 0 NOT NULL,
	"usage_threshold_cents" integer DEFAULT 100 NOT NULL,
	"usage_topup_cents" integer DEFAULT 500 NOT NULL,
	"usage_consecutive_failures" integer DEFAULT 0 NOT NULL,
	"usage_charge_in_flight" integer DEFAULT 0 NOT NULL,
	"schedule_enabled" integer DEFAULT 0 NOT NULL,
	"schedule_amount_cents" integer DEFAULT 500 NOT NULL,
	"schedule_interval_hours" integer DEFAULT 168 NOT NULL,
	"schedule_next_at" text,
	"schedule_consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_auto_topup" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"payment_reference" text,
	"created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_balances" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"last_updated" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"balance_after_cents" integer NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"reference_id" text,
	"funding_source" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "credit_transactions_reference_id_unique" UNIQUE("reference_id")
);
--> statement-breakpoint
CREATE TABLE "dividend_distributions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"date" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"pool_cents" integer NOT NULL,
	"active_users" integer NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email_type" text NOT NULL,
	"sent_at" text DEFAULT (now()) NOT NULL,
	"sent_date" text NOT NULL,
	CONSTRAINT "uniq_email_per_day" UNIQUE("tenant_id","email_type","sent_date")
);
--> statement-breakpoint
CREATE TABLE "fleet_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"fired" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"cleared_at" bigint
);
--> statement-breakpoint
CREATE TABLE "gateway_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"minute_key" bigint NOT NULL,
	"capability" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"credit_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gpu_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"droplet_id" text,
	"host" text,
	"region" text NOT NULL,
	"size" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"provision_stage" text DEFAULT 'creating' NOT NULL,
	"service_health" text,
	"monthly_cost_cents" integer,
	"last_health_at" bigint,
	"last_error" text,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_period_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"event_count" integer NOT NULL,
	"total_cost" real NOT NULL,
	"total_charge" real NOT NULL,
	"total_duration" integer DEFAULT 0 NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"cost" real NOT NULL,
	"charge" real NOT NULL,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"session_id" text,
	"duration" integer,
	"usage_units" real,
	"usage_unit_type" text,
	"tier" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "usage_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"event_count" integer NOT NULL,
	"total_cost" real NOT NULL,
	"total_charge" real NOT NULL,
	"total_duration" integer DEFAULT 0 NOT NULL,
	"window_start" bigint NOT NULL,
	"window_end" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_registration_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"expires_at" bigint NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"node_id" text,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "node_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"triggered_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"capacity_mb" integer NOT NULL,
	"used_mb" integer DEFAULT 0 NOT NULL,
	"agent_version" text,
	"last_heartbeat_at" bigint,
	"registered_at" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	"droplet_id" text,
	"region" text,
	"size" text,
	"monthly_cost_cents" integer,
	"provision_stage" text,
	"last_error" text,
	"drain_status" text,
	"drain_migrated" integer,
	"drain_total" integer,
	"owner_user_id" text,
	"node_secret" text,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"billing_low_balance" integer DEFAULT 1 NOT NULL,
	"billing_receipts" integer DEFAULT 1 NOT NULL,
	"billing_auto_topup" integer DEFAULT 1 NOT NULL,
	"agent_channel_disconnect" integer DEFAULT 1 NOT NULL,
	"agent_status_changes" integer DEFAULT 0 NOT NULL,
	"account_role_changes" integer DEFAULT 1 NOT NULL,
	"account_team_invites" integer DEFAULT 1 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email_type" text NOT NULL,
	"recipient_email" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_attempt_at" bigint,
	"last_error" text,
	"retry_after" bigint,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"sent_at" bigint
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"token" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"org_tenant_id" text NOT NULL,
	"member_tenant_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "org_memberships_org_tenant_id_member_tenant_id_pk" PRIMARY KEY("org_tenant_id","member_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "organization_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payram_charges" (
	"reference_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"currency" text,
	"filled_amount" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL,
	"credited_at" text
);
--> statement-breakpoint
CREATE TABLE "plugin_marketplace_content" (
	"plugin_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"markdown" text NOT NULL,
	"source" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"key_name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"auth_type" text NOT NULL,
	"auth_header" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"last_validated" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	"rotated_at" text,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health_overrides" (
	"adapter" text PRIMARY KEY NOT NULL,
	"healthy" integer DEFAULT 1 NOT NULL,
	"marked_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioned_phone_numbers" (
	"sid" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"provisioned_at" text DEFAULT (now()) NOT NULL,
	"last_billed_at" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit_entries" (
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" bigint NOT NULL,
	CONSTRAINT "rate_limit_entries_key_scope_pk" PRIMARY KEY("key","scope")
);
--> statement-breakpoint
CREATE TABLE "provider_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"adapter" text NOT NULL,
	"model" text,
	"unit" text NOT NULL,
	"cost_usd" real NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"latency_class" text DEFAULT 'standard' NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sell_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"display_name" text NOT NULL,
	"unit" text NOT NULL,
	"price_usd" real NOT NULL,
	"model" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"tenants_total" integer,
	"tenants_recovered" integer,
	"tenants_failed" integer,
	"tenants_waiting" integer,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"report_json" text
);
--> statement-breakpoint
CREATE TABLE "recovery_items" (
	"id" text PRIMARY KEY NOT NULL,
	"recovery_event_id" text NOT NULL,
	"tenant" text NOT NULL,
	"source_node" text NOT NULL,
	"target_node" text,
	"backup_key" text,
	"status" text NOT NULL,
	"reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" bigint,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "restore_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"snapshot_key" text NOT NULL,
	"pre_restore_key" text,
	"restored_at" bigint NOT NULL,
	"restored_by" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "tenant_security_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"require_two_factor" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text DEFAULT '' NOT NULL,
	"instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"type" text DEFAULT 'on-demand' NOT NULL,
	"s3_key" text,
	"size_mb" real DEFAULT 0 NOT NULL,
	"size_bytes" integer,
	"node_id" text,
	"trigger" text NOT NULL,
	"plugins" text DEFAULT '[]' NOT NULL,
	"config_hash" text DEFAULT '' NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"expires_at" bigint,
	"deleted_at" bigint,
	CONSTRAINT "trigger_check" CHECK (trigger IN ('manual', 'scheduled', 'pre_update')),
	CONSTRAINT "type_check" CHECK (type IN ('nightly', 'on-demand', 'pre-restore'))
);
--> statement-breakpoint
CREATE TABLE "tenant_spending_limits" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"global_alert_at" real,
	"global_hard_cap" real,
	"per_capability_json" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"encrypted_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_capability_settings" (
	"tenant_id" text NOT NULL,
	"capability" text NOT NULL,
	"mode" text DEFAULT 'hosted' NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tenant_capability_settings_tenant_id_capability_pk" PRIMARY KEY("tenant_id","capability")
);
--> statement-breakpoint
CREATE TABLE "stripe_usage_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"event_name" text NOT NULL,
	"value_cents" integer NOT NULL,
	"reported_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_customers" (
	"tenant" text PRIMARY KEY NOT NULL,
	"processor_customer_id" text NOT NULL,
	"processor" text DEFAULT 'stripe' NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"billing_hold" integer DEFAULT 0 NOT NULL,
	"inference_mode" text DEFAULT 'byok' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tenant_customers_processor_customer_id_unique" UNIQUE("processor_customer_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_model_selection" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"default_model" text DEFAULT 'openrouter/auto' NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_status" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"status_changed_at" bigint,
	"status_changed_by" text,
	"grace_deadline" text,
	"data_delete_after" text,
	"created_at" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"type" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "chk_tenants_type" CHECK ("tenants"."type" IN ('personal', 'org'))
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text,
	"granted_at" bigint NOT NULL,
	CONSTRAINT "user_roles_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "vps_subscriptions" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ssh_public_key" text,
	"cloudflare_tunnel_id" text,
	"hostname" text,
	"disk_size_gb" integer DEFAULT 20 NOT NULL,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "vps_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_seen_events" (
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"seen_at" bigint NOT NULL,
	CONSTRAINT "webhook_seen_events_event_id_source_pk" PRIMARY KEY("event_id","source")
);
--> statement-breakpoint
CREATE TABLE "webhook_sig_penalties" (
	"ip" text NOT NULL,
	"source" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"blocked_until" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "webhook_sig_penalties_ip_source_pk" PRIMARY KEY("ip","source")
);
--> statement-breakpoint
CREATE INDEX "idx_acct_del_tenant" ON "account_deletion_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_acct_del_status" ON "account_deletion_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_acct_del_delete_after" ON "account_deletion_requests" USING btree ("status","delete_after");--> statement-breakpoint
CREATE INDEX "idx_admin_audit_admin" ON "admin_audit_log" USING btree ("admin_user","created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_audit_tenant" ON "admin_audit_log" USING btree ("target_tenant","created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_audit_action" ON "admin_audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_notes_tenant" ON "admin_notes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_notes_author" ON "admin_notes" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_admin_notes_pinned" ON "admin_notes" USING btree ("tenant_id","is_pinned");--> statement-breakpoint
CREATE INDEX "idx_admin_users_email" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_admin_users_tenant" ON "admin_users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_admin_users_status" ON "admin_users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_admin_users_role" ON "admin_users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_admin_users_created" ON "admin_users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_users_last_seen" ON "admin_users" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX "idx_affiliate_ref_referrer" ON "affiliate_referrals" USING btree ("referrer_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_affiliate_ref_code" ON "affiliate_referrals" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_audit_timestamp" ON "audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_audit_user_id" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_action" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_resource" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_backup_status_node" ON "backup_status" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_backup_status_last_backup" ON "backup_status" USING btree ("last_backup_at");--> statement-breakpoint
CREATE INDEX "idx_bot_instances_tenant" ON "bot_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_bot_instances_billing_state" ON "bot_instances" USING btree ("billing_state");--> statement-breakpoint
CREATE INDEX "idx_bot_instances_destroy_after" ON "bot_instances" USING btree ("destroy_after");--> statement-breakpoint
CREATE INDEX "idx_bot_instances_node" ON "bot_instances" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_bot_profiles_tenant" ON "bot_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_bot_profiles_name" ON "bot_profiles" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "idx_bot_profiles_release_channel" ON "bot_profiles" USING btree ("release_channel");--> statement-breakpoint
CREATE INDEX "idx_bulk_undo_deadline" ON "bulk_undo_grants" USING btree ("undo_deadline");--> statement-breakpoint
CREATE INDEX "idx_circuit_window" ON "circuit_breaker_states" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "idx_auto_topup_settings_usage" ON "credit_auto_topup_settings" USING btree ("usage_enabled");--> statement-breakpoint
CREATE INDEX "idx_auto_topup_settings_schedule" ON "credit_auto_topup_settings" USING btree ("schedule_enabled","schedule_next_at");--> statement-breakpoint
CREATE INDEX "idx_auto_topup_tenant" ON "credit_auto_topup" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_auto_topup_status" ON "credit_auto_topup" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_auto_topup_created" ON "credit_auto_topup" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_auto_topup_tenant_created" ON "credit_auto_topup" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_credit_tx_tenant" ON "credit_transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_credit_tx_type" ON "credit_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_credit_tx_ref" ON "credit_transactions" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "idx_credit_tx_created" ON "credit_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_credit_tx_tenant_created" ON "credit_transactions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dividend_dist_tenant" ON "dividend_distributions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_dividend_dist_date" ON "dividend_distributions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_dividend_dist_tenant_date" ON "dividend_distributions" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "idx_email_notif_tenant" ON "email_notifications" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_email_notif_type" ON "email_notifications" USING btree ("email_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_metrics_unique" ON "gateway_metrics" USING btree ("minute_key","capability");--> statement-breakpoint
CREATE INDEX "idx_gateway_metrics_minute" ON "gateway_metrics" USING btree ("minute_key");--> statement-breakpoint
CREATE INDEX "idx_gpu_nodes_status" ON "gpu_nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_gpu_nodes_region" ON "gpu_nodes" USING btree ("region");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_period_unique" ON "billing_period_summaries" USING btree ("tenant","capability","provider","period_start");--> statement-breakpoint
CREATE INDEX "idx_billing_period_tenant" ON "billing_period_summaries" USING btree ("tenant","period_start");--> statement-breakpoint
CREATE INDEX "idx_billing_period_window" ON "billing_period_summaries" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_meter_tenant" ON "meter_events" USING btree ("tenant");--> statement-breakpoint
CREATE INDEX "idx_meter_timestamp" ON "meter_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_meter_capability" ON "meter_events" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "idx_meter_session" ON "meter_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_meter_tenant_timestamp" ON "meter_events" USING btree ("tenant","timestamp");--> statement-breakpoint
CREATE INDEX "idx_meter_tier" ON "meter_events" USING btree ("tier");--> statement-breakpoint
CREATE INDEX "idx_summary_tenant" ON "usage_summaries" USING btree ("tenant","window_start");--> statement-breakpoint
CREATE INDEX "idx_summary_window" ON "usage_summaries" USING btree ("window_start","window_end");--> statement-breakpoint
CREATE INDEX "idx_reg_tokens_user" ON "node_registration_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_reg_tokens_expires" ON "node_registration_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_node_transitions_node" ON "node_transitions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_node_transitions_created" ON "node_transitions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_nodes_status" ON "nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_nodes_droplet" ON "nodes" USING btree ("droplet_id");--> statement-breakpoint
CREATE INDEX "idx_nodes_node_secret" ON "nodes" USING btree ("node_secret");--> statement-breakpoint
CREATE INDEX "idx_notif_queue_tenant" ON "notification_queue" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_notif_queue_status" ON "notification_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notif_queue_type" ON "notification_queue" USING btree ("email_type");--> statement-breakpoint
CREATE INDEX "idx_notif_queue_retry" ON "notification_queue" USING btree ("status","retry_after");--> statement-breakpoint
CREATE INDEX "idx_oauth_states_expires" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_memberships_member_unique" ON "org_memberships" USING btree ("member_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_org_memberships_org" ON "org_memberships" USING btree ("org_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_org_invites_org_id" ON "organization_invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_invites_token" ON "organization_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_org_members_org_id" ON "organization_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_user_id" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_org_user_unique" ON "organization_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_payram_charges_tenant" ON "payram_charges" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_payram_charges_status" ON "payram_charges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payram_charges_created" ON "payram_charges" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_provider_creds_provider" ON "provider_credentials" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_provider_creds_active" ON "provider_credentials" USING btree ("provider","is_active");--> statement-breakpoint
CREATE INDEX "idx_provider_creds_created_by" ON "provider_credentials" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_provisioned_phone_tenant" ON "provisioned_phone_numbers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_provisioned_phone_last_billed" ON "provisioned_phone_numbers" USING btree ("last_billed_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limit_window" ON "rate_limit_entries" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "idx_provider_costs_capability" ON "provider_costs" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "idx_provider_costs_adapter" ON "provider_costs" USING btree ("adapter");--> statement-breakpoint
CREATE INDEX "idx_provider_costs_active" ON "provider_costs" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_costs_cap_adapter_model" ON "provider_costs" USING btree ("capability","adapter","model");--> statement-breakpoint
CREATE INDEX "idx_sell_rates_capability" ON "sell_rates" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "idx_sell_rates_active" ON "sell_rates" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sell_rates_cap_model" ON "sell_rates" USING btree ("capability","model");--> statement-breakpoint
CREATE INDEX "idx_recovery_events_node" ON "recovery_events" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_recovery_events_status" ON "recovery_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_recovery_items_event" ON "recovery_items" USING btree ("recovery_event_id");--> statement-breakpoint
CREATE INDEX "idx_recovery_items_tenant" ON "recovery_items" USING btree ("tenant");--> statement-breakpoint
CREATE INDEX "idx_restore_log_tenant" ON "restore_log" USING btree ("tenant","restored_at");--> statement-breakpoint
CREATE INDEX "idx_restore_log_restored_by" ON "restore_log" USING btree ("restored_by");--> statement-breakpoint
CREATE INDEX "idx_snapshots_instance" ON "snapshots" USING btree ("instance_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_snapshots_user" ON "snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_snapshots_tenant" ON "snapshots" USING btree ("tenant");--> statement-breakpoint
CREATE INDEX "idx_snapshots_type" ON "snapshots" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_snapshots_expires" ON "snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_keys_tenant_provider" ON "tenant_api_keys" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "idx_tenant_keys_tenant" ON "tenant_api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_keys_provider" ON "tenant_api_keys" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_stripe_usage_unique" ON "stripe_usage_reports" USING btree ("tenant","capability","provider","period_start");--> statement-breakpoint
CREATE INDEX "idx_stripe_usage_tenant" ON "stripe_usage_reports" USING btree ("tenant","reported_at");--> statement-breakpoint
CREATE INDEX "idx_tenant_customers_processor" ON "tenant_customers" USING btree ("processor_customer_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_status_status" ON "tenant_status" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tenant_status_grace" ON "tenant_status" USING btree ("grace_deadline");--> statement-breakpoint
CREATE INDEX "idx_tenant_status_delete" ON "tenant_status" USING btree ("data_delete_after");--> statement-breakpoint
CREATE INDEX "idx_tenants_slug" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_tenants_owner" ON "tenants" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_tenants_type" ON "tenants" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_user_roles_tenant" ON "user_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_user_roles_role" ON "user_roles" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_vps_sub_tenant" ON "vps_subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_vps_sub_stripe" ON "vps_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_seen_expires" ON "webhook_seen_events" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "idx_sig_penalties_blocked" ON "webhook_sig_penalties" USING btree ("blocked_until");