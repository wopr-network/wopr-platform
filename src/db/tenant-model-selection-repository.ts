import { eq } from "drizzle-orm";
import type { DrizzleDb } from "./index.js";
import { tenantModelSelection } from "./schema/tenant-model-selection.js";

export interface ITenantModelSelectionRepository {
  getDefaultModel(tenantId: string): Promise<string>;
  setDefaultModel(tenantId: string, defaultModel: string): Promise<void>;
}

export class DrizzleTenantModelSelectionRepository implements ITenantModelSelectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getDefaultModel(tenantId: string): Promise<string> {
    const rows = await this.db.select().from(tenantModelSelection).where(eq(tenantModelSelection.tenantId, tenantId));
    return rows[0]?.defaultModel ?? "openrouter/auto";
  }

  async setDefaultModel(tenantId: string, defaultModel: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(tenantModelSelection)
      .values({ tenantId, defaultModel, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantModelSelection.tenantId,
        set: { defaultModel, updatedAt: now },
      });
  }
}
