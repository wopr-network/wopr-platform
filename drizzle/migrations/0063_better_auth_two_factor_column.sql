-- Add twoFactorEnabled column to better-auth managed "user" table if it doesn't exist.
-- better-auth manages this table outside Drizzle; this migration ensures the column
-- exists so COALESCE queries in auth-user-repository.ts don't fail at query-planning time.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean NOT NULL DEFAULT false;
