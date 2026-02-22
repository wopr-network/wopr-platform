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
	`ip` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sig_penalties_blocked` ON `webhook_sig_penalties` (`blocked_until`);--> statement-breakpoint
CREATE TABLE `webhook_seen_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_seen_expires` ON `webhook_seen_events` (`seen_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`roles` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
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
CREATE INDEX `idx_circuit_window` ON `circuit_breaker_states` (`window_start`);