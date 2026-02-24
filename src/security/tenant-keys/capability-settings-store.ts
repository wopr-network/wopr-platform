import type Database from "better-sqlite3";

export const ALL_CAPABILITIES = ["transcription", "image-gen", "text-gen", "embeddings"] as const;
export type CapabilityName = (typeof ALL_CAPABILITIES)[number];

export interface TenantCapabilitySetting {
  tenant_id: string;
  capability: string;
  mode: string;
  updated_at: number;
}

export function initCapabilitySettingsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_capability_settings (
      tenant_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'hosted',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, capability)
    )
  `);
}

export class CapabilitySettingsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    initCapabilitySettingsSchema(db);
  }

  /** Get all capability settings for a tenant. Returns empty array if none set (defaults to hosted). */
  listForTenant(tenantId: string): TenantCapabilitySetting[] {
    return this.db
      .prepare("SELECT * FROM tenant_capability_settings WHERE tenant_id = ?")
      .all(tenantId) as TenantCapabilitySetting[];
  }

  /** Set the mode for a specific capability. Upserts. */
  upsert(tenantId: string, capability: string, mode: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tenant_capability_settings (tenant_id, capability, mode, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, capability) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      )
      .run(tenantId, capability, mode, now);
  }
}
