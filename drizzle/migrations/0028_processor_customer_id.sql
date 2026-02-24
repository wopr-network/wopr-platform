ALTER TABLE `tenant_customers` RENAME COLUMN `stripe_customer_id` TO `processor_customer_id`;--> statement-breakpoint
ALTER TABLE `tenant_customers` ADD `processor` text NOT NULL DEFAULT 'stripe';--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tenant_customers_stripe`;--> statement-breakpoint
CREATE INDEX `idx_tenant_customers_processor` ON `tenant_customers` (`processor_customer_id`);
