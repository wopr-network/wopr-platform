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
CREATE INDEX `idx_notif_queue_retry` ON `notification_queue` (`status`,`retry_after`);--> statement-breakpoint
CREATE TABLE `__new_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text DEFAULT '' NOT NULL,
	`instance_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`type` text DEFAULT 'on-demand' NOT NULL,
	`s3_key` text,
	`size_mb` real DEFAULT 0 NOT NULL,
	`size_bytes` integer,
	`node_id` text,
	`trigger` text NOT NULL,
	`plugins` text DEFAULT '[]' NOT NULL,
	`config_hash` text DEFAULT '' NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` integer,
	`deleted_at` integer,
	CONSTRAINT "trigger_check" CHECK(trigger IN ('manual', 'scheduled', 'pre_update')),
	CONSTRAINT "type_check" CHECK(type IN ('nightly', 'on-demand', 'pre-restore'))
);
--> statement-breakpoint
INSERT INTO `__new_snapshots`("id", "tenant", "instance_id", "user_id", "name", "type", "s3_key", "size_mb", "size_bytes", "node_id", "trigger", "plugins", "config_hash", "storage_path", "created_at", "expires_at", "deleted_at") SELECT "id", "tenant", "instance_id", "user_id", "name", "type", "s3_key", "size_mb", "size_bytes", "node_id", "trigger", "plugins", "config_hash", "storage_path", "created_at", "expires_at", "deleted_at" FROM `snapshots`;--> statement-breakpoint
DROP TABLE `snapshots`;--> statement-breakpoint
ALTER TABLE `__new_snapshots` RENAME TO `snapshots`;--> statement-breakpoint
CREATE INDEX `idx_snapshots_instance` ON `snapshots` (`instance_id`,`"created_at" desc`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_user` ON `snapshots` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_tenant` ON `snapshots` (`tenant`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_type` ON `snapshots` (`type`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_expires` ON `snapshots` (`expires_at`);