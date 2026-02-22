CREATE TABLE `credit_auto_topup_settings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`usage_enabled` integer DEFAULT 0 NOT NULL,
	`usage_threshold_cents` integer DEFAULT 500 NOT NULL,
	`usage_topup_cents` integer DEFAULT 2000 NOT NULL,
	`schedule_enabled` integer DEFAULT 0 NOT NULL,
	`schedule_interval` text,
	`schedule_amount_cents` integer,
	`schedule_next_at` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
