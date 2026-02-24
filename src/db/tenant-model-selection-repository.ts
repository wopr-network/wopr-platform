import { eq } from "drizzle-orm";
import type { DrizzleDb } from "./index.js";
import { tenantModelSelection } from "./schema/tenant-model-selection.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ITenantModelSelectionRepository {
  getDefaultModel(tenantId: string): string;
  setDefaultModel(tenantId: string, defaultModel: string): void;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

export class DrizzleTenantModelSelectionRepository implements ITenantModelSelectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  getDefaultModel(tenantId: string): string {
    const row = this.db.select().from(tenantModelSelection).where(eq(tenantModelSelection.tenantId, tenantId)).get();
    return row?.defaultModel ?? "openrouter/auto";
  }

  setDefaultModel(tenantId: string, defaultModel: string): void {
    const now = new Date().toISOString();
    this.db
      .insert(tenantModelSelection)
      .values({ tenantId, defaultModel, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantModelSelection.tenantId,
        set: { defaultModel, updatedAt: now },
      })
      .run();
  }
}
