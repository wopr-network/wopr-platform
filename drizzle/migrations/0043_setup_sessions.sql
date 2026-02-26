CREATE TABLE "setup_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"collected" text,
	"dependencies_installed" text,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	CONSTRAINT "setup_sessions_session_in_progress_uniq" UNIQUE("session_id","status")
);
--> statement-breakpoint
CREATE INDEX "setup_sessions_session_id_idx" ON "setup_sessions" ("session_id");
--> statement-breakpoint
CREATE INDEX "setup_sessions_plugin_id_idx" ON "setup_sessions" ("plugin_id");
