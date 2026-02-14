CREATE TABLE `bot_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`billing_state` text DEFAULT 'active' NOT NULL,
	`suspended_at` text,
	`destroy_after` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bot_instances_tenant` ON `bot_instances` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_instances_billing_state` ON `bot_instances` (`billing_state`);--> statement-breakpoint
CREATE INDEX `idx_bot_instances_destroy_after` ON `bot_instances` (`destroy_after`);
