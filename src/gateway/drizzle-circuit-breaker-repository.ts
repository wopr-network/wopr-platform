import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { circuitBreakerStates } from "../db/schema/index.js";
import type { ICircuitBreakerRepository } from "./circuit-breaker-repository.js";
import type { CircuitBreakerEntry } from "./repository-types.js";

export class DrizzleCircuitBreakerRepository implements ICircuitBreakerRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(instanceId: string): Promise<CircuitBreakerEntry | null> {
    const rows = await this.db
      .select()
      .from(circuitBreakerStates)
      .where(eq(circuitBreakerStates.instanceId, instanceId));
    const row = rows[0];
    if (!row) return null;
    return this.toEntry(row);
  }

  async incrementOrReset(instanceId: string, windowMs: number): Promise<CircuitBreakerEntry> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(circuitBreakerStates)
      .where(eq(circuitBreakerStates.instanceId, instanceId));
    const existing = rows[0];

    if (existing && now - existing.windowStart < windowMs) {
      // Within window: increment
      await this.db
        .update(circuitBreakerStates)
        .set({ count: sql`${circuitBreakerStates.count} + 1` })
        .where(eq(circuitBreakerStates.instanceId, instanceId));
      return {
        instanceId,
        count: existing.count + 1,
        windowStart: existing.windowStart,
        trippedAt: existing.trippedAt ?? null,
      };
    }

    // New window or new instance: upsert with count = 1
    await this.db
      .insert(circuitBreakerStates)
      .values({ instanceId, count: 1, windowStart: now, trippedAt: null })
      .onConflictDoUpdate({
        target: circuitBreakerStates.instanceId,
        set: { count: 1, windowStart: now, trippedAt: null },
      });
    return { instanceId, count: 1, windowStart: now, trippedAt: null };
  }

  async trip(instanceId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(circuitBreakerStates)
      .values({ instanceId, count: 1, windowStart: now, trippedAt: now })
      .onConflictDoUpdate({
        target: circuitBreakerStates.instanceId,
        set: { trippedAt: now },
      });
  }

  async reset(instanceId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(circuitBreakerStates)
      .values({ instanceId, count: 0, windowStart: now, trippedAt: null })
      .onConflictDoUpdate({
        target: circuitBreakerStates.instanceId,
        set: { count: 0, windowStart: now, trippedAt: null },
      });
  }

  async getAll(): Promise<CircuitBreakerEntry[]> {
    const rows = await this.db.select().from(circuitBreakerStates);
    return rows.map((r) => this.toEntry(r));
  }

  async purgeStale(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    const result = await this.db
      .delete(circuitBreakerStates)
      .where(and(lt(circuitBreakerStates.windowStart, cutoff), isNull(circuitBreakerStates.trippedAt)))
      .returning({ id: circuitBreakerStates.instanceId });
    return result.length;
  }

  private toEntry(row: typeof circuitBreakerStates.$inferSelect): CircuitBreakerEntry {
    return {
      instanceId: row.instanceId,
      count: row.count,
      windowStart: row.windowStart,
      trippedAt: row.trippedAt ?? null,
    };
  }
}
