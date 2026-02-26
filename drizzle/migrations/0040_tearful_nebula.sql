CREATE TABLE "marketplace_plugins" (
	"plugin_id" text PRIMARY KEY NOT NULL,
	"npm_package" text NOT NULL,
	"version" text NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"featured" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 999 NOT NULL,
	"category" text,
	"discovered_at" bigint NOT NULL,
	"enabled_at" bigint,
	"enabled_by" text,
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "marketplace_plugins_enabled_idx" ON "marketplace_plugins" ("enabled");