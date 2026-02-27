import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { pluginConfigs } from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface PluginConfig {
  id: string;
  botId: string;
  pluginId: string;
  configJson: string;
  encryptedFieldsJson: string | null;
  setupSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewPluginConfig = Pick<
  PluginConfig,
  "id" | "botId" | "pluginId" | "configJson" | "encryptedFieldsJson" | "setupSessionId"
>;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IPluginConfigRepository {
  upsert(config: NewPluginConfig): Promise<PluginConfig>;
  findByBotAndPlugin(botId: string, pluginId: string): Promise<PluginConfig | null>;
  deleteBySetupSession(setupSessionId: string): Promise<number>;
  deleteByBotAndPlugin(botId: string, pluginId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

type DbRow = typeof pluginConfigs.$inferSelect;

function toPluginConfig(row: DbRow): PluginConfig {
  return {
    id: row.id,
    botId: row.botId,
    pluginId: row.pluginId,
    configJson: row.configJson,
    encryptedFieldsJson: row.encryptedFieldsJson,
    setupSessionId: row.setupSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePluginConfigRepository implements IPluginConfigRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(config: NewPluginConfig): Promise<PluginConfig> {
    const rows = await this.db
      .insert(pluginConfigs)
      .values({
        id: config.id,
        botId: config.botId,
        pluginId: config.pluginId,
        configJson: config.configJson,
        encryptedFieldsJson: config.encryptedFieldsJson,
        setupSessionId: config.setupSessionId,
      })
      .onConflictDoUpdate({
        target: [pluginConfigs.botId, pluginConfigs.pluginId],
        set: {
          configJson: config.configJson,
          encryptedFieldsJson: config.encryptedFieldsJson,
          setupSessionId: config.setupSessionId,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return toPluginConfig(rows[0]);
  }

  async findByBotAndPlugin(botId: string, pluginId: string): Promise<PluginConfig | null> {
    const rows = await this.db
      .select()
      .from(pluginConfigs)
      .where(and(eq(pluginConfigs.botId, botId), eq(pluginConfigs.pluginId, pluginId)));
    return rows[0] ? toPluginConfig(rows[0]) : null;
  }

  async deleteBySetupSession(setupSessionId: string): Promise<number> {
    const rows = await this.db
      .delete(pluginConfigs)
      .where(eq(pluginConfigs.setupSessionId, setupSessionId))
      .returning({ id: pluginConfigs.id });
    return rows.length;
  }

  async deleteByBotAndPlugin(botId: string, pluginId: string): Promise<boolean> {
    const rows = await this.db
      .delete(pluginConfigs)
      .where(and(eq(pluginConfigs.botId, botId), eq(pluginConfigs.pluginId, pluginId)))
      .returning({ id: pluginConfigs.id });
    return rows.length > 0;
  }
}
