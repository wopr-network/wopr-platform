CREATE TABLE `tenant_model_selection` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`default_model` text DEFAULT 'openrouter/auto' NOT NULL,
	`updated_at` text NOT NULL
);
