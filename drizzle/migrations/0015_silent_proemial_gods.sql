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
CREATE INDEX `idx_bot_profiles_release_channel` ON `bot_profiles` (`release_channel`);