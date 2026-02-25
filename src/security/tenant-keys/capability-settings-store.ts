import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { tenantCapabilitySettings } from "../../db/schema/index.js";

export const ALL_CAPABILITIES = ["transcription", "image-gen", "text-gen", "embeddings"] as const;
export type CapabilityName = (typeof ALL_CAPABILITIES)[number];

export interface TenantCapabilitySetting {
  tenant_id: string;
  capability: string;
  mode: string;
  updated_at: number;
}

export class CapabilitySettingsStore {
  private readonly db: BetterSQLite3Database<Record<string, unknown>>;

  constructor(db: BetterSQLite3Database<Record<string, unknown>>) {
    this.db = db;
  }

  /** Get all capability settings for a tenant. Returns empty array if none set (defaults to hosted). */
  listForTenant(tenantId: string): TenantCapabilitySetting[] {
    const rows = this.db
      .select()
      .from(tenantCapabilitySettings)
      .where(eq(tenantCapabilitySettings.tenantId, tenantId))
      .all();
    return rows.map((r) => ({
      tenant_id: r.tenantId,
      capability: r.capability,
      mode: r.mode,
      updated_at: r.updatedAt,
    }));
  }

  /** Set the mode for a specific capability. Upserts. */
  upsert(tenantId: string, capability: string, mode: string): void {
    const now = Date.now();
    this.db
      .insert(tenantCapabilitySettings)
      .values({ tenantId, capability, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: [tenantCapabilitySettings.tenantId, tenantCapabilitySettings.capability],
        set: { mode, updatedAt: now },
      })
      .run();
  }
}
