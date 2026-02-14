CREATE TABLE `tenant_status` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_reason` text,
	`status_changed_at` integer,
	`status_changed_by` text,
	`grace_deadline` text,
	`data_delete_after` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tenant_status_status` ON `tenant_status` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tenant_status_grace` ON `tenant_status` (`grace_deadline`);--> statement-breakpoint
CREATE INDEX `idx_tenant_status_delete` ON `tenant_status` (`data_delete_after`);