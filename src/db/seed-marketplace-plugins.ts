/**
 * src/db/seed-marketplace-plugins.ts
 *
 * Drizzle logic for seeding the marketplace_plugins table.
 * Called by scripts/seed-marketplace-plugins.ts.
 */

import { createDb, eq } from "@wopr-network/platform-core/db/index";
import { marketplacePlugins } from "@wopr-network/platform-core/db/schema/marketplace-plugins";
import { FIRST_PARTY_PLUGINS } from "@wopr-network/platform-core/marketplace/first-party-plugins";
import type { Pool } from "pg";

export async function seedMarketplacePlugins(pool: Pool): Promise<void> {
  const db = createDb(pool);
  const now = Date.now();

  console.info(`Seeding ${FIRST_PARTY_PLUGINS.length} first-party plugins...`);

  for (const plugin of FIRST_PARTY_PLUGINS) {
    const {
      id,
      version,
      category,
      name,
      description,
      author,
      icon,
      color,
      tags,
      capabilities,
      requires,
      install,
      configSchema,
      setup,
      installCount,
      changelog,
    } = plugin;

    const manifest = {
      name,
      description,
      author,
      icon,
      color,
      tags,
      capabilities,
      requires,
      install,
      configSchema,
      setup,
      installCount,
      changelog,
    };

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
      console.info(`  inserted: ${id}`);
    } else {
      const npmPackage = install[0] ?? `@wopr-network/wopr-plugin-${id}`;
      await db
        .update(marketplacePlugins)
        .set({ manifest, version, category, npmPackage })
        .where(eq(marketplacePlugins.pluginId, id));
      console.info(`  updated: ${id}`);
    }
  }

  console.info("Done.");
}
