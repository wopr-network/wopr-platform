import { eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { providerHealthOverrides } from "../db/schema/index.js";
import type { IProviderHealthRepository } from "./provider-health-repository.js";
import type { ProviderHealthOverride } from "./repository-types.js";

export class DrizzleProviderHealthRepository implements IProviderHealthRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(adapter: string): Promise<ProviderHealthOverride | null> {
    const row = (
      await this.db.select().from(providerHealthOverrides).where(eq(providerHealthOverrides.adapter, adapter))
    )[0];
    if (!row) return null;
    return { adapter: row.adapter, healthy: row.healthy === 1, markedAt: row.markedAt };
  }

  async getAll(): Promise<ProviderHealthOverride[]> {
    const rows = await this.db.select().from(providerHealthOverrides);
    return rows.map((row) => ({ adapter: row.adapter, healthy: row.healthy === 1, markedAt: row.markedAt }));
  }

  async markUnhealthy(adapter: string): Promise<void> {
    await this.db
      .insert(providerHealthOverrides)
      .values({ adapter, healthy: 0, markedAt: Date.now() })
      .onConflictDoUpdate({
        target: providerHealthOverrides.adapter,
        set: { healthy: 0, markedAt: Date.now() },
      });
  }

  async markHealthy(adapter: string): Promise<void> {
    await this.db.delete(providerHealthOverrides).where(eq(providerHealthOverrides.adapter, adapter));
  }

  async purgeExpired(unhealthyTtlMs: number): Promise<number> {
    const cutoff = Date.now() - unhealthyTtlMs;
    const result = await this.db
      .delete(providerHealthOverrides)
      .where(lt(providerHealthOverrides.markedAt, cutoff))
      .returning({ id: providerHealthOverrides.adapter });
    return result.length;
  }
}
