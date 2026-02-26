import { randomUUID } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { nodeRegistrationTokens } from "../db/schema/index.js";

const TOKEN_TTL_S = 900; // 15 minutes

export class RegistrationTokenStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Create a new one-time registration token. Returns the token value. */
  async create(userId: string, label?: string): Promise<{ token: string; expiresAt: number }> {
    const token = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TOKEN_TTL_S;

    await this.db.insert(nodeRegistrationTokens).values({
      id: token,
      userId,
      label: label ?? null,
      createdAt: now,
      expiresAt,
    });

    return { token, expiresAt };
  }

  /**
   * Consume a token. Returns the token row if valid and unused, null otherwise.
   * Marks the token as used atomically.
   */
  async consume(
    token: string,
    nodeId: string,
  ): Promise<{
    userId: string;
    label: string | null;
  } | null> {
    const now = Math.floor(Date.now() / 1000);

    const row = (
      await this.db
        .select()
        .from(nodeRegistrationTokens)
        .where(
          and(
            eq(nodeRegistrationTokens.id, token),
            eq(nodeRegistrationTokens.used, false),
            gt(nodeRegistrationTokens.expiresAt, now),
          ),
        )
    )[0];

    if (!row) return null;

    await this.db
      .update(nodeRegistrationTokens)
      .set({ used: true, nodeId, usedAt: now })
      .where(eq(nodeRegistrationTokens.id, token));

    return { userId: row.userId, label: row.label };
  }

  /** List active (unexpired, unused) tokens for a user. */
  async listActive(userId: string) {
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
      );
  }

  /** Purge expired tokens (housekeeping). */
  async purgeExpired(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .delete(nodeRegistrationTokens)
      .where(and(eq(nodeRegistrationTokens.used, false), lt(nodeRegistrationTokens.expiresAt, now)))
      .returning({ id: nodeRegistrationTokens.id });
    return result.length;
  }
}
