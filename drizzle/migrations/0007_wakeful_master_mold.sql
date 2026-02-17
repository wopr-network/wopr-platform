CREATE TABLE `provider_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`adapter` text NOT NULL,
	`model` text,
	`unit` text NOT NULL,
	`cost_usd` real NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`latency_class` text DEFAULT 'standard' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_costs_capability` ON `provider_costs` (`capability`);--> statement-breakpoint
CREATE INDEX `idx_provider_costs_adapter` ON `provider_costs` (`adapter`);--> statement-breakpoint
CREATE INDEX `idx_provider_costs_active` ON `provider_costs` (`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_costs_cap_adapter_model` ON `provider_costs` (`capability`,`adapter`,`model`);--> statement-breakpoint
CREATE TABLE `sell_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`display_name` text NOT NULL,
	`unit` text NOT NULL,
	`price_usd` real NOT NULL,
	`model` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sell_rates_capability` ON `sell_rates` (`capability`);--> statement-breakpoint
CREATE INDEX `idx_sell_rates_active` ON `sell_rates` (`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sell_rates_cap_model` ON `sell_rates` (`capability`,`model`);
