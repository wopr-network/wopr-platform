CREATE TABLE `provisioned_phone_numbers` (
	`sid` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`phone_number` text NOT NULL,
	`provisioned_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_billed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_provisioned_phone_tenant` ON `provisioned_phone_numbers` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_provisioned_phone_last_billed` ON `provisioned_phone_numbers` (`last_billed_at`);
