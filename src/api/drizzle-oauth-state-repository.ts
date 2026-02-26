import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { oauthStates } from "../db/schema/index.js";
import type { IOAuthStateRepository } from "./oauth-state-repository.js";
import type { OAuthState } from "./repository-types.js";

export class DrizzleOAuthStateRepository implements IOAuthStateRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(data: Omit<OAuthState, "token" | "status">): Promise<OAuthState> {
    await this.db.insert(oauthStates).values({
      state: data.state,
      provider: data.provider,
      userId: data.userId,
      redirectUri: data.redirectUri,
      status: "pending",
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
    });
    return { ...data, token: null, status: "pending" };
  }

  async consumePending(state: string): Promise<OAuthState | null> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.state, state), eq(oauthStates.status, "pending")));
    const row = rows[0];
    if (!row) return null;
    if (now > row.expiresAt) {
      await this.db.delete(oauthStates).where(eq(oauthStates.state, state));
      return null;
    }
    await this.db.delete(oauthStates).where(eq(oauthStates.state, state));
    return this.toOAuthState(row);
  }

  async completeWithToken(state: string, token: string, userId: string): Promise<void> {
    // Re-insert with the real userId so consumeCompleted can enforce ownership.
    // consumePending already deleted the pending row; we re-create it as
    // "completed". The userId must be non-empty so the ownership check in
    // consumeCompleted cannot be bypassed by an attacker who fabricates a state
    // token (a fabricated insert would require knowing the real userId).
    await this.db
      .insert(oauthStates)
      .values({
        state,
        provider: "",
        userId,
        redirectUri: "",
        token,
        status: "completed",
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      })
      .onConflictDoUpdate({
        target: oauthStates.state,
        set: { token, status: "completed", userId },
      });
  }

  async consumeCompleted(state: string, userId: string): Promise<OAuthState | null> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.state, state), eq(oauthStates.status, "completed")));
    const row = rows[0];
    if (!row) return null;
    // Row must belong to this user. The empty-string exemption was removed:
    // an upsert-inserted row with userId="" must not be consumable by any user.
    if (row.userId !== userId) return null;
    if (now > row.expiresAt) {
      await this.db.delete(oauthStates).where(eq(oauthStates.state, state));
      return null;
    }
    await this.db.delete(oauthStates).where(eq(oauthStates.state, state));
    return this.toOAuthState(row);
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    const result = await this.db
      .delete(oauthStates)
      .where(lt(oauthStates.expiresAt, now))
      .returning({ state: oauthStates.state });
    return result.length;
  }

  private toOAuthState(row: typeof oauthStates.$inferSelect): OAuthState {
    return {
      state: row.state,
      provider: row.provider,
      userId: row.userId,
      redirectUri: row.redirectUri,
      token: row.token,
      status: row.status as OAuthState["status"],
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}
