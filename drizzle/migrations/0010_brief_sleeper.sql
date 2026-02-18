CREATE TABLE `admin_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_admin_notes_tenant` ON `admin_notes` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_notes_author` ON `admin_notes` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_admin_notes_pinned` ON `admin_notes` (`tenant_id`,`is_pinned`);--> statement-breakpoint
CREATE TABLE `notification_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email_type` text NOT NULL,
	`recipient_email` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`last_attempt_at` text,
	`last_error` text,
	`retry_after` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_notif_queue_tenant` ON `notification_queue` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_notif_queue_status` ON `notification_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_notif_queue_type` ON `notification_queue` (`email_type`);--> statement-breakpoint
CREATE INDEX `idx_notif_queue_retry` ON `notification_queue` (`status`,`retry_after`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tenant_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_user_roles_tenant` ON `user_roles` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_user_roles_role` ON `user_roles` (`role`);