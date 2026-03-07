-- Add twoFactorEnabled column to better-auth managed "user" table if it doesn't exist.
-- better-auth manages this table outside Drizzle; this migration is a no-op if the
-- table doesn't exist yet (e.g. in Drizzle test environments where better-auth tables
-- are created separately by runAuthMigrations()).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user'
  ) THEN
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean NOT NULL DEFAULT false;
  END IF;
END
$$;
