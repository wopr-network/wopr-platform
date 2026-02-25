CREATE TABLE `plugin_marketplace_content` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`markdown` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL
);
