import { and, eq, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { rateLimitEntries } from "../db/schema/index.js";
import type { IRateLimitRepository } from "./rate-limit-repository.js";
import type { RateLimitEntry } from "./repository-types.js";

export class DrizzleRateLimitRepository implements IRateLimitRepository {
  constructor(private readonly db: DrizzleDb) {}

  async increment(key: string, scope: string, windowMs: number): Promise<RateLimitEntry> {
    const now = Date.now();

    // Check if existing entry is within the current window
    const rows = await this.db
      .select()
      .from(rateLimitEntries)
      .where(and(eq(rateLimitEntries.key, key), eq(rateLimitEntries.scope, scope)));
    const existing = rows[0];

    if (existing && now - existing.windowStart < windowMs) {
      // Within window: increment
      await this.db
        .update(rateLimitEntries)
        .set({ count: sql`${rateLimitEntries.count} + 1` })
        .where(and(eq(rateLimitEntries.key, key), eq(rateLimitEntries.scope, scope)));
      return { key, scope, count: existing.count + 1, windowStart: existing.windowStart };
    }

    // New window (or first request): upsert with count = 1
    await this.db
      .insert(rateLimitEntries)
      .values({ key, scope, count: 1, windowStart: now })
      .onConflictDoUpdate({
        target: [rateLimitEntries.key, rateLimitEntries.scope],
        set: { count: 1, windowStart: now },
      });
    return { key, scope, count: 1, windowStart: now };
  }

  async get(key: string, scope: string): Promise<RateLimitEntry | null> {
    const rows = await this.db
      .select()
      .from(rateLimitEntries)
      .where(and(eq(rateLimitEntries.key, key), eq(rateLimitEntries.scope, scope)));
    const row = rows[0];
    if (!row) return null;
    return { key: row.key, scope: row.scope, count: row.count, windowStart: row.windowStart };
  }

  async purgeStale(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    const result = await this.db
      .delete(rateLimitEntries)
      .where(lt(rateLimitEntries.windowStart, cutoff))
      .returning({ key: rateLimitEntries.key });
    return result.length;
  }
}
