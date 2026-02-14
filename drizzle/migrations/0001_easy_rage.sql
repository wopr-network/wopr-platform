PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`size_mb` real DEFAULT 0 NOT NULL,
	`trigger` text NOT NULL,
	`plugins` text DEFAULT '[]' NOT NULL,
	`config_hash` text DEFAULT '' NOT NULL,
	`storage_path` text NOT NULL,
	CONSTRAINT "trigger_check" CHECK(trigger IN ('manual', 'scheduled', 'pre_update'))
);
--> statement-breakpoint
INSERT INTO `__new_snapshots`("id", "instance_id", "user_id", "created_at", "size_mb", "trigger", "plugins", "config_hash", "storage_path") SELECT "id", "instance_id", "user_id", "created_at", "size_mb", "trigger", "plugins", "config_hash", "storage_path" FROM `snapshots`;--> statement-breakpoint
DROP TABLE `snapshots`;--> statement-breakpoint
ALTER TABLE `__new_snapshots` RENAME TO `snapshots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_snapshots_instance` ON `snapshots` (`instance_id`,`"created_at" desc`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_user` ON `snapshots` (`user_id`);