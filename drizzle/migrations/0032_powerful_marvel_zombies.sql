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
	`processor_customer_id` text NOT NULL,
	`processor` text DEFAULT 'stripe' NOT NULL,
	`tier` text DEFAULT 'free' NOT NULL,
	`billing_hold` integer DEFAULT 0 NOT NULL,
	`inference_mode` text DEFAULT 'byok' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_customers_processor_customer_id_unique` ON `tenant_customers` (`processor_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_tenant_customers_processor` ON `tenant_customers` (`processor_customer_id`);