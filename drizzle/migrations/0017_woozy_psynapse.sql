CREATE TABLE `credit_auto_topup` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`payment_reference` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auto_topup_tenant` ON `credit_auto_topup` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_status` ON `credit_auto_topup` (`status`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_created` ON `credit_auto_topup` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_auto_topup_tenant_created` ON `credit_auto_topup` (`tenant_id`,`created_at`);
