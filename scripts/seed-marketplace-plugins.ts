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

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { marketplacePlugins } from "../src/db/schema/marketplace-plugins.js";
import { FIRST_PARTY_PLUGINS } from "../src/marketplace/first-party-plugins.js";

// ---------------------------------------------------------------------------
// Seed runner
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  const now = Date.now();

  console.log(`Seeding ${FIRST_PARTY_PLUGINS.length} first-party plugins...`);

  for (const plugin of FIRST_PARTY_PLUGINS) {
    const { id, version, category, name, description, author, icon, color, tags, capabilities, requires, install, configSchema, setup, installCount, changelog } = plugin;

    const manifest = { name, description, author, icon, color, tags, capabilities, requires, install, configSchema, setup, installCount, changelog };

    const existing = await db.select().from(marketplacePlugins).where(eq(marketplacePlugins.pluginId, id));

    if (existing.length === 0) {
      await db.insert(marketplacePlugins).values({
        pluginId: id,
        npmPackage: install[0] ?? `@wopr-network/wopr-plugin-${id}`,
        version,
        category,
        notes: description,
        manifest,
        enabled: true,
        enabledAt: now,
        enabledBy: "seed",
        discoveredAt: now,
        sortOrder: FIRST_PARTY_PLUGINS.indexOf(plugin),
      });
      console.log(`  inserted: ${id}`);
    } else {
      const npmPackage = install[0] ?? `@wopr-network/wopr-plugin-${id}`;
      await db
        .update(marketplacePlugins)
        .set({ manifest, version, category, npmPackage })
        .where(eq(marketplacePlugins.pluginId, id));
      console.log(`  updated: ${id}`);
    }
  }

  await pool.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
