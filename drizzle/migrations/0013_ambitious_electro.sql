CREATE TABLE `account_deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`delete_after` text NOT NULL,
	`cancel_reason` text,
	`completed_at` text,
	`deletion_summary` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_acct_del_tenant` ON `account_deletion_requests` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_acct_del_status` ON `account_deletion_requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_acct_del_delete_after` ON `account_deletion_requests` (`status`,`delete_after`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acct_del_tenant_pending` ON `account_deletion_requests` (`tenant_id`) WHERE `status` = 'pending';