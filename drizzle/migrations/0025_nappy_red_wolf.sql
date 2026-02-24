CREATE TABLE `affiliate_codes` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_codes_code_unique` ON `affiliate_codes` (`code`);--> statement-breakpoint
CREATE TABLE `affiliate_referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`referrer_tenant_id` text NOT NULL,
	`referred_tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`signed_up_at` text DEFAULT (datetime('now')) NOT NULL,
	`first_purchase_at` text,
	`match_amount_cents` integer,
	`matched_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_referrals_referred_tenant_id_unique` ON `affiliate_referrals` (`referred_tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_affiliate_ref_referrer` ON `affiliate_referrals` (`referrer_tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_affiliate_ref_code` ON `affiliate_referrals` (`code`);