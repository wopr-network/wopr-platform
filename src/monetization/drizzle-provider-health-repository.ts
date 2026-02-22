import { eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { providerHealthOverrides } from "../db/schema/index.js";
import type { IProviderHealthRepository } from "./provider-health-repository.js";
import type { ProviderHealthOverride } from "./repository-types.js";

export class DrizzleProviderHealthRepository implements IProviderHealthRepository {
  constructor(private readonly db: DrizzleDb) {}

  get(adapter: string): ProviderHealthOverride | null {
    const row = this.db
      .select()
      .from(providerHealthOverrides)
      .where(eq(providerHealthOverrides.adapter, adapter))
      .get();
    if (!row) return null;
    return { adapter: row.adapter, healthy: row.healthy === 1, markedAt: row.markedAt };
  }

  getAll(): ProviderHealthOverride[] {
    return this.db
      .select()
      .from(providerHealthOverrides)
      .all()
      .map((row) => ({ adapter: row.adapter, healthy: row.healthy === 1, markedAt: row.markedAt }));
  }

  markUnhealthy(adapter: string): void {
    this.db
      .insert(providerHealthOverrides)
      .values({ adapter, healthy: 0, markedAt: Date.now() })
      .onConflictDoUpdate({
        target: providerHealthOverrides.adapter,
        set: { healthy: 0, markedAt: Date.now() },
      })
      .run();
  }

  markHealthy(adapter: string): void {
    this.db.delete(providerHealthOverrides).where(eq(providerHealthOverrides.adapter, adapter)).run();
  }

  purgeExpired(unhealthyTtlMs: number): number {
    const cutoff = Date.now() - unhealthyTtlMs;
    const result = this.db.delete(providerHealthOverrides).where(lt(providerHealthOverrides.markedAt, cutoff)).run();
    return result.changes;
  }
}
