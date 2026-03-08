CREATE TABLE IF NOT EXISTS "account_export_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"format" text DEFAULT 'json' NOT NULL,
	"download_url" text,
	"created_at" text DEFAULT (now()) NOT NULL,
	"updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_acct_export_tenant" ON "account_export_requests" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_acct_export_status" ON "account_export_requests" USING btree ("status");
