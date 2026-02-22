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
CREATE INDEX `idx_auto_topup_settings_schedule` ON `credit_auto_topup_settings` (`schedule_enabled`,`schedule_next_at`);