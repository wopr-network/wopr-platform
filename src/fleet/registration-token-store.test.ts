import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { RegistrationTokenStore } from "./registration-token-store.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS node_registration_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      node_id TEXT,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reg_tokens_user ON node_registration_tokens (user_id);
    CREATE INDEX IF NOT EXISTS idx_reg_tokens_expires ON node_registration_tokens (expires_at);
  `);
  return drizzle(sqlite, { schema });
}

describe("RegistrationTokenStore", () => {
  let store: RegistrationTokenStore;
  let now: number;

  beforeEach(() => {
    store = new RegistrationTokenStore(makeDb());
    now = Math.floor(Date.now() / 1000);
  });

  describe("create", () => {
    it("creates a token with correct 15-minute TTL", () => {
      const result = store.create("user-1");
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe("string");
      // expiresAt should be ~15 minutes (900s) from now
      expect(result.expiresAt).toBeGreaterThanOrEqual(now + 899);
      expect(result.expiresAt).toBeLessThanOrEqual(now + 901);
    });

    it("creates a token with a label", () => {
      const result = store.create("user-1", "Living room Mac Mini");
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeGreaterThan(now);
    });

    it("creates unique tokens each time", () => {
      const r1 = store.create("user-1");
      const r2 = store.create("user-1");
      expect(r1.token).not.toBe(r2.token);
    });

    it("token is UUID format", () => {
      const { token } = store.create("user-1");
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe("consume", () => {
    it("consumes a valid token successfully", () => {
      const { token } = store.create("user-1", "My Mac Mini");
      const result = store.consume(token, "self-abc123");
      expect(result).not.toBeNull();
      expect(result?.userId).toBe("user-1");
      expect(result?.label).toBe("My Mac Mini");
    });

    it("returns null when token does not exist", () => {
      const result = store.consume("00000000-0000-0000-0000-000000000000", "node-1");
      expect(result).toBeNull();
    });

    it("rejects an already-consumed token", () => {
      const { token } = store.create("user-1");
      store.consume(token, "self-abc1");
      const result = store.consume(token, "self-abc2");
      expect(result).toBeNull();
    });

    it("rejects a token with expiresAt in the past", () => {
      // Insert a token that is already expired (expiresAt = 1 second in the past)
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS node_registration_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          node_id TEXT,
          used_at INTEGER
        );
      `);
      const expiredDb = drizzle(sqlite, { schema });
      const expiredStore = new RegistrationTokenStore(expiredDb);

      const pastTime = Math.floor(Date.now() / 1000) - 1000; // 1000 seconds in past
      // Insert directly via raw SQL to set expiresAt in the past
      const token = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      sqlite
        .prepare(
          "INSERT INTO node_registration_tokens (id, user_id, label, created_at, expires_at, used) VALUES (?, ?, NULL, ?, ?, 0)",
        )
        .run(token, "user-1", pastTime - 900, pastTime);

      const result = expiredStore.consume(token, "self-abc1");
      expect(result).toBeNull();
    });

    it("marks token as used after consumption", () => {
      const { token } = store.create("user-1");
      store.consume(token, "self-abc1");
      // Trying again returns null
      expect(store.consume(token, "self-abc1")).toBeNull();
    });

    it("returns label as null when not set", () => {
      const { token } = store.create("user-2");
      const result = store.consume(token, "self-xyz");
      expect(result?.label).toBeNull();
    });
  });

  describe("listActive", () => {
    it("lists only unexpired unused tokens for the user", () => {
      store.create("user-1", "Token A");
      store.create("user-1", "Token B");
      store.create("user-2", "Token C");

      const active = store.listActive("user-1");
      expect(active).toHaveLength(2);
      expect(active.every((t) => t.userId === "user-1")).toBe(true);
    });

    it("excludes consumed tokens", () => {
      const { token } = store.create("user-1");
      store.create("user-1");
      store.consume(token, "node-1");

      const active = store.listActive("user-1");
      expect(active).toHaveLength(1);
    });

    it("returns empty array when no active tokens", () => {
      const active = store.listActive("user-nobody");
      expect(active).toHaveLength(0);
    });
  });

  describe("purgeExpired", () => {
    it("returns count of deleted rows (0 when none expired)", () => {
      store.create("user-1");
      const count = store.purgeExpired();
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
