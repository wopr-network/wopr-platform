ALTER TABLE `bot_instances` ADD `created_by_user_id` text;--> statement-breakpoint
CREATE INDEX `idx_bot_instances_created_by` ON `bot_instances` (`created_by_user_id`);