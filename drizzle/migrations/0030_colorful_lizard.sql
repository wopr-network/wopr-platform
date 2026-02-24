DROP TABLE `stripe_usage_reports`;--> statement-breakpoint
DROP TABLE `tenant_customers`;--> statement-breakpoint
ALTER TABLE `bot_instances` ADD `storage_tier` text DEFAULT 'standard' NOT NULL;