CREATE TABLE "session_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text,
	"page" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_session_usage_session" ON "session_usage" ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_usage_user" ON "session_usage" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_usage_created" ON "session_usage" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_session_usage_page" ON "session_usage" ("page");
