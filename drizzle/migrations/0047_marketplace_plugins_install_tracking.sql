ALTER TABLE "marketplace_plugins" ADD COLUMN IF NOT EXISTS "installed_at" bigint;
ALTER TABLE "marketplace_plugins" ADD COLUMN IF NOT EXISTS "install_error" text;
