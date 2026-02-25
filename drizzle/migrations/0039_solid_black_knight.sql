ALTER TABLE `credit_transactions` ADD `attributed_user_id` text;--> statement-breakpoint
CREATE INDEX `idx_credit_tx_attributed_user` ON `credit_transactions` (`attributed_user_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_tx_tenant_attributed` ON `credit_transactions` (`tenant_id`,`attributed_user_id`);