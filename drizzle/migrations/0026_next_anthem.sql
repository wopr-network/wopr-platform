CREATE TABLE `credit_auto_topup_settings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`usage_enabled` integer DEFAULT 0 NOT NULL,
	`usage_threshold_cents` integer DEFAULT 100 NOT NULL,
	`usage_topup_cents` integer DEFAULT 500 NOT NULL,
	`usage_consecutive_failures` integer DEFAULT 0 NOT NULL,
	`usage_charge_in_flight` integer DEFAULT 0 NOT NULL,
	`schedule_enabled` integer DEFAULT 0 NOT NULL,
	`schedule_amount_cents` integer DEFAULT 500 NOT NULL,
	`schedule_interval_hours` integer DEFAULT 168 NOT NULL,
	`schedule_next_at` text,
	`schedule_consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auto_topup_settings_usage` ON `credit_auto_topup_settings` (`usage_enabled`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_settings_schedule` ON `credit_auto_topup_settings` (`schedule_enabled`,`schedule_next_at`);--> statement-breakpoint
CREATE TABLE `dividend_distributions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`pool_cents` integer NOT NULL,
	`active_users` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dividend_dist_tenant` ON `dividend_distributions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_dividend_dist_date` ON `dividend_distributions` (`date`);--> statement-breakpoint
CREATE INDEX `idx_dividend_dist_tenant_date` ON `dividend_distributions` (`tenant_id`,`date`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`token` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_states_expires` ON `oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `webhook_sig_penalties` (
	`ip` text NOT NULL,
	`source` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`ip`, `source`)
);
--> statement-breakpoint
CREATE INDEX `idx_sig_penalties_blocked` ON `webhook_sig_penalties` (`blocked_until`);--> statement-breakpoint
CREATE TABLE `webhook_seen_events` (
	`event_id` text NOT NULL,
	`source` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `source`)
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_seen_expires` ON `webhook_seen_events` (`seen_at`);--> statement-breakpoint
CREATE TABLE `provider_health_overrides` (
	`adapter` text PRIMARY KEY NOT NULL,
	`healthy` integer DEFAULT 1 NOT NULL,
	`marked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fleet_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`fired` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`cleared_at` integer
);
--> statement-breakpoint
CREATE TABLE `gateway_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`minute_key` integer NOT NULL,
	`capability` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`credit_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gateway_metrics_unique` ON `gateway_metrics` (`minute_key`,`capability`);--> statement-breakpoint
CREATE INDEX `idx_gateway_metrics_minute` ON `gateway_metrics` (`minute_key`);--> statement-breakpoint
CREATE TABLE `rate_limit_entries` (
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	PRIMARY KEY(`key`, `scope`)
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limit_window` ON `rate_limit_entries` (`window_start`);--> statement-breakpoint
CREATE TABLE `circuit_breaker_states` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`tripped_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_circuit_window` ON `circuit_breaker_states` (`window_start`);--> statement-breakpoint
CREATE TABLE `provisioned_phone_numbers` (
	`sid` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`phone_number` text NOT NULL,
	`provisioned_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_billed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_provisioned_phone_tenant` ON `provisioned_phone_numbers` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_provisioned_phone_last_billed` ON `provisioned_phone_numbers` (`last_billed_at`);