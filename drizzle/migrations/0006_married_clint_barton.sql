CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`capacity_mb` integer NOT NULL,
	`used_mb` integer DEFAULT 0 NOT NULL,
	`agent_version` text,
	`last_heartbeat_at` integer,
	`registered_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_nodes_status` ON `nodes` (`status`);--> statement-breakpoint
CREATE TABLE `recovery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`tenants_total` integer,
	`tenants_recovered` integer,
	`tenants_failed` integer,
	`tenants_waiting` integer,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`report_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_recovery_events_node` ON `recovery_events` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_recovery_events_status` ON `recovery_events` (`status`);--> statement-breakpoint
CREATE TABLE `recovery_items` (
	`id` text PRIMARY KEY NOT NULL,
	`recovery_event_id` text NOT NULL,
	`tenant` text NOT NULL,
	`source_node` text NOT NULL,
	`target_node` text,
	`backup_key` text,
	`status` text NOT NULL,
	`reason` text,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_recovery_items_event` ON `recovery_items` (`recovery_event_id`);--> statement-breakpoint
CREATE INDEX `idx_recovery_items_tenant` ON `recovery_items` (`tenant`);--> statement-breakpoint
ALTER TABLE `bot_instances` ADD `node_id` text;--> statement-breakpoint
CREATE INDEX `idx_bot_instances_node` ON `bot_instances` (`node_id`);--> statement-breakpoint
ALTER TABLE `meter_events` ADD `usage_units` real;--> statement-breakpoint
ALTER TABLE `meter_events` ADD `usage_unit_type` text;--> statement-breakpoint
ALTER TABLE `meter_events` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `meter_events` ADD `metadata` text;--> statement-breakpoint
CREATE INDEX `idx_meter_tier` ON `meter_events` (`tier`);