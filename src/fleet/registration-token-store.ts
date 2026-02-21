import { randomUUID } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema/index.js";
import { nodeRegistrationTokens } from "../db/schema/index.js";

const TOKEN_TTL_S = 900; // 15 minutes

export class RegistrationTokenStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  /** Create a new one-time registration token. Returns the token value. */
  create(userId: string, label?: string): { token: string; expiresAt: number } {
    const token = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TOKEN_TTL_S;

    this.db
      .insert(nodeRegistrationTokens)
      .values({
        id: token,
        userId,
        label: label ?? null,
        createdAt: now,
        expiresAt,
      })
      .run();

    return { token, expiresAt };
  }

  /**
   * Consume a token. Returns the token row if valid and unused, null otherwise.
   * Marks the token as used atomically.
   */
  consume(
    token: string,
    nodeId: string,
  ): {
    userId: string;
    label: string | null;
  } | null {
    const now = Math.floor(Date.now() / 1000);

    const row = this.db
      .select()
      .from(nodeRegistrationTokens)
      .where(
        and(
          eq(nodeRegistrationTokens.id, token),
          eq(nodeRegistrationTokens.used, false),
          gt(nodeRegistrationTokens.expiresAt, now),
        ),
      )
      .get();

    if (!row) return null;

    this.db
      .update(nodeRegistrationTokens)
      .set({ used: true, nodeId, usedAt: now })
      .where(eq(nodeRegistrationTokens.id, token))
      .run();

    return { userId: row.userId, label: row.label };
  }

  /** List active (unexpired, unused) tokens for a user. */
  listActive(userId: string) {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .select()
      .from(nodeRegistrationTokens)
      .where(
        and(
          eq(nodeRegistrationTokens.userId, userId),
          eq(nodeRegistrationTokens.used, false),
          gt(nodeRegistrationTokens.expiresAt, now),
        ),
      )
      .all();
  }

  /** Purge expired tokens (housekeeping). */
  purgeExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .delete(nodeRegistrationTokens)
      .where(and(eq(nodeRegistrationTokens.used, false), lt(nodeRegistrationTokens.expiresAt, now)))
      .run();
    return result.changes;
  }
}
