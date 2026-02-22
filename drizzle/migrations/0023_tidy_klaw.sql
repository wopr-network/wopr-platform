CREATE TABLE `tenant_spending_limits` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`global_alert_at` real,
	`global_hard_cap` real,
	`per_capability_json` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tenant_customers` ADD `inference_mode` text DEFAULT 'byok' NOT NULL;