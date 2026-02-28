-- WOP-1113: create platform_api_keys table for DB-backed API key auth
CREATE TABLE IF NOT EXISTS "platform_api_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "key_hash" text NOT NULL,
  "user_id" text NOT NULL,
  "roles" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "expires_at" bigint,
  "revoked_at" bigint,
  "created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_api_keys_hash" ON "platform_api_keys" ("key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_api_keys_user" ON "platform_api_keys" ("user_id");
