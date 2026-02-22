CREATE TABLE `admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`tenant_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active', 'suspended', 'grace_period', 'dormant', 'banned')),
	`role` text DEFAULT 'user' NOT NULL CHECK (`role` IN ('platform_admin', 'tenant_admin', 'user')),
	`credit_balance_cents` integer DEFAULT 0 NOT NULL,
	`agent_count` integer DEFAULT 0 NOT NULL,
	`last_seen` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_admin_users_email` ON `admin_users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_tenant` ON `admin_users` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_status` ON `admin_users` (`status`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_role` ON `admin_users` (`role`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_created` ON `admin_users` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_last_seen` ON `admin_users` (`last_seen`);--> statement-breakpoint
CREATE TABLE `bulk_undo_grants` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`tenant_ids` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`admin_user` text NOT NULL,
	`created_at` integer NOT NULL,
	`undo_deadline` integer NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bulk_undo_deadline` ON `bulk_undo_grants` (`undo_deadline`);