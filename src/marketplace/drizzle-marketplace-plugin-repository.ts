import { asc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { marketplacePlugins } from "../db/schema/index.js";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";
import type { MarketplacePlugin, NewMarketplacePlugin } from "./marketplace-repository-types.js";

function rowToDomain(row: typeof marketplacePlugins.$inferSelect): MarketplacePlugin {
  return {
    pluginId: row.pluginId,
    npmPackage: row.npmPackage,
    version: row.version,
    enabled: row.enabled === 1,
    featured: row.featured === 1,
    sortOrder: row.sortOrder,
    category: row.category,
    discoveredAt: row.discoveredAt,
    enabledAt: row.enabledAt,
    enabledBy: row.enabledBy,
    notes: row.notes,
  };
}

export class DrizzleMarketplacePluginRepository implements IMarketplacePluginRepository {
  constructor(private readonly db: DrizzleDb) {}

  findAll(): MarketplacePlugin[] {
    return this.db.select().from(marketplacePlugins).orderBy(asc(marketplacePlugins.sortOrder)).all().map(rowToDomain);
  }

  findEnabled(): MarketplacePlugin[] {
    return this.db
      .select()
      .from(marketplacePlugins)
      .where(eq(marketplacePlugins.enabled, 1))
      .orderBy(asc(marketplacePlugins.sortOrder))
      .all()
      .map(rowToDomain);
  }

  findPendingReview(): MarketplacePlugin[] {
    return this.db
      .select()
      .from(marketplacePlugins)
      .where(eq(marketplacePlugins.enabled, 0))
      .orderBy(asc(marketplacePlugins.discoveredAt))
      .all()
      .map(rowToDomain);
  }

  findById(pluginId: string): MarketplacePlugin | undefined {
    const row = this.db.select().from(marketplacePlugins).where(eq(marketplacePlugins.pluginId, pluginId)).get();
    return row ? rowToDomain(row) : undefined;
  }

  insert(plugin: NewMarketplacePlugin): MarketplacePlugin {
    const now = Date.now();
    this.db
      .insert(marketplacePlugins)
      .values({
        pluginId: plugin.pluginId,
        npmPackage: plugin.npmPackage,
        version: plugin.version,
        category: plugin.category ?? null,
        notes: plugin.notes ?? null,
        discoveredAt: now,
      })
      .run();
    const inserted = this.findById(plugin.pluginId);
    if (!inserted) throw new Error(`Failed to insert marketplace plugin: ${plugin.pluginId}`);
    return inserted;
  }

  update(pluginId: string, patch: Partial<MarketplacePlugin>): MarketplacePlugin {
    const updates: Record<string, unknown> = {};
    if (patch.enabled !== undefined) updates.enabled = patch.enabled ? 1 : 0;
    if (patch.featured !== undefined) updates.featured = patch.featured ? 1 : 0;
    if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;
    if (patch.category !== undefined) updates.category = patch.category;
    if (patch.enabledBy !== undefined) updates.enabledBy = patch.enabledBy;
    if (patch.notes !== undefined) updates.notes = patch.notes;
    if (patch.version !== undefined) updates.version = patch.version;
    // Auto-set enabledAt when enabling
    if (patch.enabled === true) updates.enabledAt = Date.now();
    if (Object.keys(updates).length > 0) {
      this.db.update(marketplacePlugins).set(updates).where(eq(marketplacePlugins.pluginId, pluginId)).run();
    }
    const updated = this.findById(pluginId);
    if (!updated) throw new Error(`Marketplace plugin not found after update: ${pluginId}`);
    return updated;
  }

  delete(pluginId: string): void {
    this.db.delete(marketplacePlugins).where(eq(marketplacePlugins.pluginId, pluginId)).run();
  }
}
