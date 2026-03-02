CREATE TABLE IF NOT EXISTS "page_contexts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"current_page" text NOT NULL,
	"page_prompt" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_contexts_updated_at_idx" ON "page_contexts" USING btree ("updated_at");
