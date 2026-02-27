CREATE TABLE "plugin_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"config_json" text NOT NULL,
	"encrypted_fields_json" text,
	"setup_session_id" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL,
	CONSTRAINT "plugin_configs_bot_plugin_uniq" UNIQUE("bot_id","plugin_id")
);
--> statement-breakpoint
CREATE INDEX "plugin_configs_bot_id_idx" ON "plugin_configs" USING btree ("bot_id");
--> statement-breakpoint
CREATE INDEX "plugin_configs_setup_session_idx" ON "plugin_configs" USING btree ("setup_session_id");
