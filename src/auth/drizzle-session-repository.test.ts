/**
 * Unit tests for DrizzleSessionRepository (WOP-927).
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleSessionRepository } from "./drizzle-session-repository.js";

function makeRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      roles TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  return { sqlite, repo: new DrizzleSessionRepository(drizzle(sqlite, { schema })) };
}

describe("DrizzleSessionRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let repo: DrizzleSessionRepository;

  beforeEach(() => {
    const r = makeRepo();
    sqlite = r.sqlite;
    repo = r.repo;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates and validates a session", () => {
    const session = repo.create({
      id: "sess-1",
      userId: "user-1",
      roles: ["admin"],
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    expect(session.id).toBe("sess-1");

    const validated = repo.validate("sess-1");
    expect(validated).not.toBeNull();
    expect(validated?.userId).toBe("user-1");
    expect(validated?.roles).toEqual(["admin"]);
  });

  it("returns null for unknown session", () => {
    expect(repo.validate("unknown")).toBeNull();
  });

  it("returns null for expired session and removes it", () => {
    repo.create({
      id: "sess-expired",
      userId: "user-1",
      roles: [],
      createdAt: Date.now() - 7_200_000,
      expiresAt: Date.now() - 3_600_000,
    });

    const result = repo.validate("sess-expired");
    expect(result).toBeNull();

    // Should be removed from DB
    expect(repo.size).toBe(0);
  });

  it("revokes a session", () => {
    repo.create({
      id: "sess-2",
      userId: "user-1",
      roles: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });

    expect(repo.revoke("sess-2")).toBe(true);
    expect(repo.validate("sess-2")).toBeNull();
  });

  it("revoke returns false for non-existent session", () => {
    expect(repo.revoke("no-such-session")).toBe(false);
  });

  it("purgeExpired removes expired sessions and returns count", () => {
    repo.create({
      id: "active",
      userId: "user-1",
      roles: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    repo.create({
      id: "expired",
      userId: "user-2",
      roles: [],
      createdAt: Date.now() - 7_200_000,
      expiresAt: Date.now() - 1,
    });

    const removed = repo.purgeExpired();
    expect(removed).toBe(1);
    expect(repo.size).toBe(1);
    expect(repo.validate("active")).not.toBeNull();
  });

  it("size reflects number of stored sessions", () => {
    expect(repo.size).toBe(0);
    repo.create({ id: "a", userId: "u1", roles: [], createdAt: Date.now(), expiresAt: Date.now() + 1000 });
    expect(repo.size).toBe(1);
    repo.create({ id: "b", userId: "u1", roles: [], createdAt: Date.now(), expiresAt: Date.now() + 1000 });
    expect(repo.size).toBe(2);
  });
});
