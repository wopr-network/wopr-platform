CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`key_name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`auth_type` text NOT NULL,
	`auth_header` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`last_validated` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`rotated_at` text,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_creds_provider` ON `provider_credentials` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_provider_creds_active` ON `provider_credentials` (`provider`,`is_active`);--> statement-breakpoint
CREATE INDEX `idx_provider_creds_created_by` ON `provider_credentials` (`created_by`);