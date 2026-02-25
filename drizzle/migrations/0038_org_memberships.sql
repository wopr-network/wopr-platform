CREATE TABLE IF NOT EXISTS `org_memberships` (
	`org_tenant_id` text NOT NULL,
	`member_tenant_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_tenant_id`, `member_tenant_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_org_memberships_member_unique` ON `org_memberships` (`member_tenant_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_org_memberships_org` ON `org_memberships` (`org_tenant_id`);
