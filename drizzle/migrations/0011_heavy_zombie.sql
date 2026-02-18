CREATE TABLE `restore_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`snapshot_key` text NOT NULL,
	`pre_restore_key` text,
	`restored_at` integer NOT NULL,
	`restored_by` text NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_restore_log_tenant` ON `restore_log` (`tenant`,`restored_at`);--> statement-breakpoint
CREATE INDEX `idx_restore_log_restored_by` ON `restore_log` (`restored_by`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email_type` text NOT NULL,
	`recipient_email` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	`retry_after` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_notification_queue`("id", "tenant_id", "email_type", "recipient_email", "payload", "status", "attempts", "max_attempts", "last_attempt_at", "last_error", "retry_after", "created_at", "sent_at") SELECT "id", "tenant_id", "email_type", "recipient_email", "payload", "status", "attempts", "max_attempts", "last_attempt_at", "last_error", "retry_after", "created_at", "sent_at" FROM `notification_queue`;--> statement-breakpoint
DROP TABLE `notification_queue`;--> statement-breakpoint
ALTER TABLE `__new_notification_queue` RENAME TO `notification_queue`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_notif_queue_tenant` ON `notification_queue` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_notif_queue_status` ON `notification_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_notif_queue_type` ON `notification_queue` (`email_type`);--> statement-breakpoint
CREATE INDEX `idx_notif_queue_retry` ON `notification_queue` (`status`,`retry_after`);