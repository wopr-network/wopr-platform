CREATE TABLE `billing_period_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`capability` text NOT NULL,
	`provider` text NOT NULL,
	`event_count` integer NOT NULL,
	`total_cost` real NOT NULL,
	`total_charge` real NOT NULL,
	`total_duration` integer DEFAULT 0 NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_billing_period_unique` ON `billing_period_summaries` (`tenant`,`capability`,`provider`,`period_start`);--> statement-breakpoint
CREATE INDEX `idx_billing_period_tenant` ON `billing_period_summaries` (`tenant`,`period_start`);--> statement-breakpoint
CREATE INDEX `idx_billing_period_window` ON `billing_period_summaries` (`period_start`,`period_end`);--> statement-breakpoint
CREATE TABLE `meter_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`cost` real NOT NULL,
	`charge` real NOT NULL,
	`capability` text NOT NULL,
	`provider` text NOT NULL,
	`timestamp` integer NOT NULL,
	`session_id` text,
	`duration` integer
);
--> statement-breakpoint
CREATE INDEX `idx_meter_tenant` ON `meter_events` (`tenant`);--> statement-breakpoint
CREATE INDEX `idx_meter_timestamp` ON `meter_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_meter_capability` ON `meter_events` (`capability`);--> statement-breakpoint
CREATE INDEX `idx_meter_session` ON `meter_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_meter_tenant_timestamp` ON `meter_events` (`tenant`,`timestamp`);--> statement-breakpoint
CREATE TABLE `usage_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`capability` text NOT NULL,
	`provider` text NOT NULL,
	`event_count` integer NOT NULL,
	`total_cost` real NOT NULL,
	`total_charge` real NOT NULL,
	`total_duration` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_summary_tenant` ON `usage_summaries` (`tenant`,`window_start`);--> statement-breakpoint
CREATE INDEX `idx_summary_window` ON `usage_summaries` (`window_start`,`window_end`);--> statement-breakpoint
CREATE TABLE `stripe_usage_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`capability` text NOT NULL,
	`provider` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`event_name` text NOT NULL,
	`value_cents` integer NOT NULL,
	`reported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stripe_usage_unique` ON `stripe_usage_reports` (`tenant`,`capability`,`provider`,`period_start`);--> statement-breakpoint
CREATE INDEX `idx_stripe_usage_tenant` ON `stripe_usage_reports` (`tenant`,`reported_at`);--> statement-breakpoint
CREATE TABLE `tenant_customers` (
	`tenant` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_subscription_id` text,
	`tier` text DEFAULT 'free' NOT NULL,
	`billing_hold` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_customers_stripe_customer_id_unique` ON `tenant_customers` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_tenant_customers_stripe` ON `tenant_customers` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`user_id` text NOT NULL,
	`auth_method` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`details` text,
	`ip_address` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_timestamp` ON `audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_user_id` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource` ON `audit_log` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user` text NOT NULL,
	`action` text NOT NULL,
	`category` text NOT NULL,
	`target_tenant` text,
	`target_user` text,
	`details` text DEFAULT '{}' NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_admin_audit_admin` ON `admin_audit_log` (`admin_user`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_audit_tenant` ON `admin_audit_log` (`target_tenant`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_audit_action` ON `admin_audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`size_mb` real DEFAULT 0 NOT NULL,
	`trigger` text NOT NULL,
	`plugins` text DEFAULT '[]' NOT NULL,
	`config_hash` text DEFAULT '' NOT NULL,
	`storage_path` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_instance` ON `snapshots` (`instance_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_snapshots_user` ON `snapshots` (`user_id`);