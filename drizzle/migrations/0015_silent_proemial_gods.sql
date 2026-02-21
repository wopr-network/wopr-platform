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
CREATE TABLE `node_registration_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`used` integer DEFAULT false NOT NULL,
	`node_id` text,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_reg_tokens_user` ON `node_registration_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_reg_tokens_expires` ON `node_registration_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `node_secret` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `label` text;