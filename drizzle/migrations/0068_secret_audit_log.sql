CREATE TABLE "secret_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"accessed_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"accessed_by" text NOT NULL,
	"action" text NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE INDEX "idx_secret_audit_credential" ON "secret_audit_log" USING btree ("credential_id","accessed_at");--> statement-breakpoint
CREATE INDEX "idx_secret_audit_accessed_by" ON "secret_audit_log" USING btree ("accessed_by");
