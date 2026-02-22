import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleOAuthStateRepository } from "./drizzle-oauth-state-repository.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      token TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);
  `);
  return drizzle(sqlite, { schema });
}

describe("DrizzleOAuthStateRepository", () => {
  let repo: DrizzleOAuthStateRepository;

  beforeEach(() => {
    repo = new DrizzleOAuthStateRepository(makeDb());
  });

  it("creates and consumes a pending state", () => {
    repo.create({
      state: "test-uuid",
      provider: "slack",
      userId: "user-1",
      redirectUri: "https://example.com/cb",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });

    const consumed = repo.consumePending("test-uuid");
    expect(consumed).not.toBeNull();
    expect(consumed!.provider).toBe("slack");

    const again = repo.consumePending("test-uuid");
    expect(again).toBeNull();
  });

  it("stores and retrieves completed token", () => {
    repo.create({
      state: "s1",
      provider: "slack",
      userId: "user-1",
      redirectUri: "https://example.com/cb",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });

    repo.completeWithToken("s1", "tok_abc");

    const result = repo.consumeCompleted("s1", "user-1");
    expect(result).not.toBeNull();
    expect(result!.token).toBe("tok_abc");

    const again = repo.consumeCompleted("s1", "user-1");
    expect(again).toBeNull();
  });

  it("returns null for expired state", () => {
    repo.create({
      state: "expired",
      provider: "slack",
      userId: "user-1",
      redirectUri: "https://example.com/cb",
      createdAt: Date.now() - 700_000,
      expiresAt: Date.now() - 100_000,
    });

    const result = repo.consumePending("expired");
    expect(result).toBeNull();
  });
});
