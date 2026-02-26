import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { pluginMarketplaceContent } from "../db/schema/plugin-marketplace-content.js";

export interface PluginMarketplaceContentRow {
  pluginId: string;
  version: string;
  markdown: string;
  source: "superpower_md" | "manifest_description";
  updatedAt: number;
}

export interface IMarketplaceContentRepository {
  getByPluginId(pluginId: string): Promise<PluginMarketplaceContentRow | null>;
  upsert(row: PluginMarketplaceContentRow): Promise<void>;
}

export class DrizzleMarketplaceContentRepository implements IMarketplaceContentRepository {
  constructor(private db: DrizzleDb) {}

  async getByPluginId(pluginId: string): Promise<PluginMarketplaceContentRow | null> {
    const rows = await this.db
      .select()
      .from(pluginMarketplaceContent)
      .where(eq(pluginMarketplaceContent.pluginId, pluginId));
    const row = rows[0];
    if (!row) return null;
    return {
      pluginId: row.pluginId,
      version: row.version,
      markdown: row.markdown,
      source: row.source as "superpower_md" | "manifest_description",
      updatedAt: row.updatedAt,
    };
  }

  async upsert(row: PluginMarketplaceContentRow): Promise<void> {
    await this.db
      .insert(pluginMarketplaceContent)
      .values({
        pluginId: row.pluginId,
        version: row.version,
        markdown: row.markdown,
        source: row.source,
        updatedAt: row.updatedAt,
      })
      .onConflictDoUpdate({
        target: pluginMarketplaceContent.pluginId,
        set: {
          version: row.version,
          markdown: row.markdown,
          source: row.source,
          updatedAt: row.updatedAt,
        },
      });
  }
}
