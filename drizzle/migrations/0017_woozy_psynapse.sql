CREATE TABLE `bot_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`restart_policy` text DEFAULT 'unless-stopped' NOT NULL,
	`update_policy` text DEFAULT 'on-push' NOT NULL,
	`release_channel` text DEFAULT 'stable' NOT NULL,
	`volume_name` text,
	`discovery_json` text,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_tenant` ON `bot_profiles` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_name` ON `bot_profiles` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_release_channel` ON `bot_profiles` (`release_channel`);--> statement-breakpoint
CREATE TABLE `credit_auto_topup` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`payment_reference` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auto_topup_tenant` ON `credit_auto_topup` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_status` ON `credit_auto_topup` (`status`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_created` ON `credit_auto_topup` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_tenant_created` ON `credit_auto_topup` (`tenant_id`,`created_at`);