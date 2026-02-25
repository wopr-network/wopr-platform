DROP TABLE `tenant_customers`;--> statement-breakpoint
DROP TABLE `stripe_usage_reports`;--> statement-breakpoint
ALTER TABLE `bot_instances` ADD `resource_tier` text DEFAULT 'standard' NOT NULL;