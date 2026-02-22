import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { circuitBreakerStates } from "../db/schema/index.js";
import type { ICircuitBreakerRepository } from "./circuit-breaker-repository.js";
import type { CircuitBreakerEntry } from "./repository-types.js";

export class DrizzleCircuitBreakerRepository implements ICircuitBreakerRepository {
  constructor(private readonly db: DrizzleDb) {}

  get(instanceId: string): CircuitBreakerEntry | null {
    const row = this.db
      .select()
      .from(circuitBreakerStates)
      .where(eq(circuitBreakerStates.instanceId, instanceId))
      .get();
    if (!row) return null;
    return this.toEntry(row);
  }

  incrementOrReset(instanceId: string, windowMs: number): CircuitBreakerEntry {
    const now = Date.now();
    const existing = this.db
      .select()
      .from(circuitBreakerStates)
      .where(eq(circuitBreakerStates.instanceId, instanceId))
      .get();

    if (existing && now - existing.windowStart < windowMs) {
      // Within window: increment
      this.db
        .update(circuitBreakerStates)
        .set({ count: sql`${circuitBreakerStates.count} + 1` })
        .where(eq(circuitBreakerStates.instanceId, instanceId))
        .run();
      return {
        instanceId,
        count: existing.count + 1,
        windowStart: existing.windowStart,
        trippedAt: existing.trippedAt ?? null,
      };
    }

    // New window or new instance: upsert with count = 1
    this.db
      .insert(circuitBreakerStates)
      .values({ instanceId, count: 1, windowStart: now, trippedAt: null })
      .onConflictDoUpdate({
        target: circuitBreakerStates.instanceId,
        set: { count: 1, windowStart: now, trippedAt: null },
      })
      .run();
    return { instanceId, count: 1, windowStart: now, trippedAt: null };
  }

  trip(instanceId: string): void {
    const now = Date.now();
    this.db
      .insert(circuitBreakerStates)
      .values({ instanceId, count: 1, windowStart: now, trippedAt: now })
      .onConflictDoUpdate({
        target: circuitBreakerStates.instanceId,
        set: { trippedAt: now },
      })
      .run();
  }

  reset(instanceId: string): void {
    const now = Date.now();
    this.db
      .insert(circuitBreakerStates)
      .values({ instanceId, count: 0, windowStart: now, trippedAt: null })
      .onConflictDoUpdate({
        target: circuitBreakerStates.instanceId,
        set: { count: 0, windowStart: now, trippedAt: null },
      })
      .run();
  }

  getAll(): CircuitBreakerEntry[] {
    const rows = this.db.select().from(circuitBreakerStates).all();
    return rows.map((r) => this.toEntry(r));
  }

  purgeStale(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const result = this.db
      .delete(circuitBreakerStates)
      .where(and(lt(circuitBreakerStates.windowStart, cutoff), isNull(circuitBreakerStates.trippedAt)))
      .run();
    return result.changes;
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
