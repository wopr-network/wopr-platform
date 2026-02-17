ALTER TABLE `nodes` ADD `droplet_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `region` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `size` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `monthly_cost_cents` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `provision_stage` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `drain_status` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `drain_migrated` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `drain_total` integer;--> statement-breakpoint
CREATE INDEX `idx_nodes_droplet` ON `nodes` (`droplet_id`);