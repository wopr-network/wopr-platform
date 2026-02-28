-- WOP-1113: enforce uniqueness on platform_api_keys.key_hash
-- Replace plain index with a unique index to prevent duplicate hashes
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'platform_api_keys' AND indexname = 'idx_platform_api_keys_hash'
  ) THEN
    DROP INDEX IF EXISTS "idx_platform_api_keys_hash";
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_api_keys_hash" ON "platform_api_keys" ("key_hash");
