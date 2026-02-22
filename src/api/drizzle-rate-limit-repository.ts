import { and, eq, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { rateLimitEntries } from "../db/schema/index.js";
import type { IRateLimitRepository } from "./rate-limit-repository.js";
import type { RateLimitEntry } from "./repository-types.js";

export class DrizzleRateLimitRepository implements IRateLimitRepository {
  constructor(private readonly db: DrizzleDb) {}

  increment(key: string, scope: string, windowMs: number): RateLimitEntry {
    const now = Date.now();

    // Check if existing entry is within the current window
    const existing = this.db
      .select()
      .from(rateLimitEntries)
      .where(and(eq(rateLimitEntries.key, key), eq(rateLimitEntries.scope, scope)))
      .get();

    if (existing && now - existing.windowStart < windowMs) {
      // Within window: increment
      this.db
        .update(rateLimitEntries)
        .set({ count: sql`${rateLimitEntries.count} + 1` })
        .where(and(eq(rateLimitEntries.key, key), eq(rateLimitEntries.scope, scope)))
        .run();
      return { key, scope, count: existing.count + 1, windowStart: existing.windowStart };
    }

    // New window (or first request): upsert with count = 1
    this.db
      .insert(rateLimitEntries)
      .values({ key, scope, count: 1, windowStart: now })
      .onConflictDoUpdate({
        target: [rateLimitEntries.key, rateLimitEntries.scope],
        set: { count: 1, windowStart: now },
      })
      .run();
    return { key, scope, count: 1, windowStart: now };
  }

  get(key: string, scope: string): RateLimitEntry | null {
    const row = this.db
      .select()
      .from(rateLimitEntries)
      .where(and(eq(rateLimitEntries.key, key), eq(rateLimitEntries.scope, scope)))
      .get();
    if (!row) return null;
    return { key: row.key, scope: row.scope, count: row.count, windowStart: row.windowStart };
  }

  purgeStale(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const result = this.db.delete(rateLimitEntries).where(lt(rateLimitEntries.windowStart, cutoff)).run();
    return result.changes;
  }
}
