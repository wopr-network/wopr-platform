-- Migration: add manifest column to marketplace_plugins
-- Safe: ADD COLUMN with no NOT NULL constraint (nullable, no default needed)
ALTER TABLE "marketplace_plugins" ADD COLUMN "manifest" jsonb;
