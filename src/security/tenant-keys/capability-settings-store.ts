import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
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
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  /** Get all capability settings for a tenant. Returns empty array if none set (defaults to hosted). */
  async listForTenant(tenantId: string): Promise<TenantCapabilitySetting[]> {
    const rows = await this.db
      .select()
      .from(tenantCapabilitySettings)
      .where(eq(tenantCapabilitySettings.tenantId, tenantId));
    return rows.map((r) => ({
      tenant_id: r.tenantId,
      capability: r.capability,
      mode: r.mode,
      updated_at: r.updatedAt,
    }));
  }

  /** Set the mode for a specific capability. Upserts. */
  async upsert(tenantId: string, capability: string, mode: string): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(tenantCapabilitySettings)
      .values({ tenantId, capability, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: [tenantCapabilitySettings.tenantId, tenantCapabilitySettings.capability],
        set: { mode, updatedAt: now },
      });
  }
}
