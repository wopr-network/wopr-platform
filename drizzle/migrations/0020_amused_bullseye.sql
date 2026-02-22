CREATE TABLE `gpu_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`droplet_id` text,
	`host` text,
	`region` text NOT NULL,
	`size` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`provision_stage` text DEFAULT 'creating' NOT NULL,
	`service_health` text,
	`monthly_cost_cents` integer,
	`last_health_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_gpu_nodes_status` ON `gpu_nodes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_gpu_nodes_region` ON `gpu_nodes` (`region`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`tenant_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`credit_balance_cents` integer DEFAULT 0 NOT NULL,
	`agent_count` integer DEFAULT 0 NOT NULL,
	`last_seen` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_admin_users_status" CHECK("__new_admin_users"."status" IN ('active', 'suspended', 'grace_period', 'dormant', 'banned')),
	CONSTRAINT "chk_admin_users_role" CHECK("__new_admin_users"."role" IN ('platform_admin', 'tenant_admin', 'user'))
);
--> statement-breakpoint
INSERT INTO `__new_admin_users`("id", "email", "name", "tenant_id", "status", "role", "credit_balance_cents", "agent_count", "last_seen", "created_at") SELECT "id", "email", "name", "tenant_id", "status", "role", "credit_balance_cents", "agent_count", "last_seen", "created_at" FROM `admin_users`;--> statement-breakpoint
DROP TABLE `admin_users`;--> statement-breakpoint
ALTER TABLE `__new_admin_users` RENAME TO `admin_users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_admin_users_email` ON `admin_users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_tenant` ON `admin_users` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_status` ON `admin_users` (`status`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_role` ON `admin_users` (`role`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_created` ON `admin_users` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_users_last_seen` ON `admin_users` (`last_seen`);