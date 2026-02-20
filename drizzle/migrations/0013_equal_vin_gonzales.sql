CREATE TABLE `tenant_security_settings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`require_two_factor` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
