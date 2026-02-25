CREATE TABLE `organization_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`invited_by` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invites_token_unique` ON `organization_invites` (`token`);--> statement-breakpoint
CREATE INDEX `idx_org_invites_org_id` ON `organization_invites` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_org_invites_token` ON `organization_invites` (`token`);--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_org_members_org_id` ON `organization_members` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_org_members_user_id` ON `organization_members` (`user_id`);