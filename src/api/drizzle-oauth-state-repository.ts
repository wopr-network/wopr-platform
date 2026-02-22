import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { oauthStates } from "../db/schema/index.js";
import type { IOAuthStateRepository } from "./oauth-state-repository.js";
import type { OAuthState } from "./repository-types.js";

export class DrizzleOAuthStateRepository implements IOAuthStateRepository {
  constructor(private readonly db: DrizzleDb) {}

  create(data: Omit<OAuthState, "token" | "status">): OAuthState {
    this.db
      .insert(oauthStates)
      .values({
        state: data.state,
        provider: data.provider,
        userId: data.userId,
        redirectUri: data.redirectUri,
        status: "pending",
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
      })
      .run();
    return { ...data, token: null, status: "pending" };
  }

  consumePending(state: string): OAuthState | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.state, state), eq(oauthStates.status, "pending")))
      .get();
    if (!row) return null;
    if (now > row.expiresAt) {
      this.db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
      return null;
    }
    this.db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
    return this.toOAuthState(row);
  }

  completeWithToken(state: string, token: string): void {
    this.db
      .insert(oauthStates)
      .values({
        state,
        provider: "",
        userId: "",
        redirectUri: "",
        token,
        status: "completed",
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      })
      .onConflictDoUpdate({
        target: oauthStates.state,
        set: { token, status: "completed" },
      })
      .run();
  }

  consumeCompleted(state: string, userId: string): OAuthState | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.state, state), eq(oauthStates.status, "completed")))
      .get();
    if (!row) return null;
    if (row.userId !== userId && row.userId !== "") return null;
    if (now > row.expiresAt) {
      this.db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
      return null;
    }
    this.db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
    return this.toOAuthState(row);
  }

  purgeExpired(): number {
    const now = Date.now();
    const result = this.db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)).run();
    return result.changes;
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
