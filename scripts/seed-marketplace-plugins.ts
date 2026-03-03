/**
 * scripts/seed-marketplace-plugins.ts
 *
 * Seed the marketplace_plugins table with first-party plugin definitions.
 * Run this once after deploying a fresh database, or to update manifest data.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/seed-marketplace-plugins.ts
 *
 * Behaviour:
 *   - Upserts each plugin: inserts if not present, updates manifest if already exists.
 *   - Does NOT re-enable disabled plugins (preserves admin overrides).
 *   - Enables plugins that have never been touched (enabled = false, enabledAt = null).
 */

import { Pool } from "pg";
import { seedMarketplacePlugins } from "../src/db/seed-marketplace-plugins.js";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  await seedMarketplacePlugins(pool);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
