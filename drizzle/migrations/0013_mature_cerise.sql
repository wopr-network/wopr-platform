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
ALTER TABLE `nodes` ADD `label` text;--> statement-breakpoint
ALTER TABLE `recovery_items` ADD `retry_count` integer DEFAULT 0 NOT NULL;