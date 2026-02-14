CREATE TABLE `credit_balances` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`last_updated` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credit_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`balance_after_cents` integer NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`reference_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_transactions_reference_id_unique` ON `credit_transactions` (`reference_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_tx_tenant` ON `credit_transactions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_tx_type` ON `credit_transactions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_credit_tx_ref` ON `credit_transactions` (`reference_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_tx_created` ON `credit_transactions` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_credit_tx_tenant_created` ON `credit_transactions` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email_type` text NOT NULL,
	`sent_at` text DEFAULT (datetime('now')) NOT NULL,
	`sent_date` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_email_notif_tenant` ON `email_notifications` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_email_notif_type` ON `email_notifications` (`email_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_email_per_day` ON `email_notifications` (`tenant_id`,`email_type`,`sent_date`);--> statement-breakpoint
ALTER TABLE `tenant_customers` DROP COLUMN `stripe_subscription_id`;