CREATE TABLE `node_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`triggered_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_node_transitions_node` ON `node_transitions` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_node_transitions_created` ON `node_transitions` (`created_at`);