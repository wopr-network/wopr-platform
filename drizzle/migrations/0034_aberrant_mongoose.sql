PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`type` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "chk_tenants_type" CHECK("__new_tenants"."type" IN ('personal', 'org'))
);
--> statement-breakpoint
INSERT INTO `__new_tenants`("id", "name", "slug", "type", "owner_id", "created_at") SELECT "id", "name", "slug", "type", "owner_id", "created_at" FROM `tenants`;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_tenants_slug` ON `tenants` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_tenants_owner` ON `tenants` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_tenants_type` ON `tenants` (`type`);