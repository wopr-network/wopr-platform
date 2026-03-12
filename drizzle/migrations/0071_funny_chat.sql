-- Snapshot sync: schema definitions moved from local src/db/schema/ to
-- @wopr-network/platform-core npm package. All tables, columns, and types
-- referenced in this snapshot already exist from migrations 0000-0070.
-- This migration is intentionally empty — it only exists to update the
-- drizzle-kit snapshot to match the npm package's schema exports.
SELECT 1;
