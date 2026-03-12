import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { eq } from "@wopr-network/platform-core/db/index";
import { tenantModelSelection } from "@wopr-network/platform-core/db/schema/tenant-model-selection";

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
