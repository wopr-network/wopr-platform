import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { webhookSigPenalties } from "../db/schema/index.js";
import type { SigPenalty } from "./repository-types.js";
import type { ISigPenaltyRepository } from "./sig-penalty-repository.js";

const MAX_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

export class DrizzleSigPenaltyRepository implements ISigPenaltyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(ip: string, source: string): Promise<SigPenalty | null> {
    const rows = await this.db
      .select()
      .from(webhookSigPenalties)
      .where(and(eq(webhookSigPenalties.ip, ip), eq(webhookSigPenalties.source, source)));
    return rows[0] ? this.toSigPenalty(rows[0]) : null;
  }

  async recordFailure(ip: string, source: string): Promise<SigPenalty> {
    const now = Date.now();
    const existing = await this.get(ip, source);
    const failures = (existing?.failures ?? 0) + 1;
    const backoffMs = Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS);
    const blockedUntil = now + backoffMs;

    await this.db
      .insert(webhookSigPenalties)
      .values({ ip, source, failures, blockedUntil, updatedAt: now })
      .onConflictDoUpdate({
        target: [webhookSigPenalties.ip, webhookSigPenalties.source],
        set: { failures, blockedUntil, updatedAt: now },
      });

    return { ip, source, failures, blockedUntil, updatedAt: now };
  }

  async clear(ip: string, source: string): Promise<void> {
    await this.db
      .delete(webhookSigPenalties)
      .where(and(eq(webhookSigPenalties.ip, ip), eq(webhookSigPenalties.source, source)));
  }

  async purgeStale(decayMs: number): Promise<number> {
    const cutoff = Date.now() - decayMs;
    const result = await this.db
      .delete(webhookSigPenalties)
      .where(lt(webhookSigPenalties.blockedUntil, cutoff))
      .returning({ ip: webhookSigPenalties.ip });
    return result.length;
  }

  private toSigPenalty(row: typeof webhookSigPenalties.$inferSelect): SigPenalty {
    return {
      ip: row.ip,
      source: row.source,
      failures: row.failures,
      blockedUntil: row.blockedUntil,
      updatedAt: row.updatedAt,
    };
  }
}
