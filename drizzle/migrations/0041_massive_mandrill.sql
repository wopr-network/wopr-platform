CREATE TABLE "onboarding_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"anonymous_id" text,
	"wopr_session_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"budget_used_cents" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "onboarding_sessions_wopr_session_name_unique" UNIQUE("wopr_session_name")
);
--> statement-breakpoint
CREATE INDEX "onboarding_sessions_user_id_idx" ON "onboarding_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "onboarding_sessions_anonymous_id_idx" ON "onboarding_sessions" ("anonymous_id");