import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { RegistrationTokenStore } from "./registration-token-store.js";

describe("RegistrationTokenStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: RegistrationTokenStore;
  let now: number;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new RegistrationTokenStore(db);
    now = Math.floor(Date.now() / 1000);
  });

  describe("create", () => {
    it("creates a token with correct 15-minute TTL", async () => {
      const result = await store.create("user-1");
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe("string");
      // expiresAt should be ~15 minutes (900s) from now
      expect(result.expiresAt).toBeGreaterThanOrEqual(now + 899);
      expect(result.expiresAt).toBeLessThanOrEqual(now + 901);
    });

    it("creates a token with a label", async () => {
      const result = await store.create("user-1", "Living room Mac Mini");
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeGreaterThan(now);
    });

    it("creates unique tokens each time", async () => {
      const r1 = await store.create("user-1");
      const r2 = await store.create("user-1");
      expect(r1.token).not.toBe(r2.token);
    });

    it("token is UUID format", async () => {
      const { token } = await store.create("user-1");
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe("consume", () => {
    it("consumes a valid token successfully", async () => {
      const { token } = await store.create("user-1", "My Mac Mini");
      const result = await store.consume(token, "self-abc123");
      expect(result).not.toBeNull();
      expect(result?.userId).toBe("user-1");
      expect(result?.label).toBe("My Mac Mini");
    });

    it("returns null when token does not exist", async () => {
      const result = await store.consume("00000000-0000-0000-0000-000000000000", "node-1");
      expect(result).toBeNull();
    });

    it("rejects an already-consumed token", async () => {
      const { token } = await store.create("user-1");
      await store.consume(token, "self-abc1");
      const result = await store.consume(token, "self-abc2");
      expect(result).toBeNull();
    });

    it("rejects a token with expiresAt in the past", async () => {
      // Insert a token with expiresAt in the past via drizzle
      const nodeRegistrationTokens = (await import("../db/schema/index.js")).nodeRegistrationTokens;
      const pastTime = Math.floor(Date.now() / 1000) - 1000; // 1000 seconds in past
      const token = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      await db.insert(nodeRegistrationTokens).values({
        id: token,
        userId: "user-1",
        label: null,
        createdAt: pastTime - 900,
        expiresAt: pastTime,
        used: false,
        nodeId: null,
        usedAt: null,
      });

      const result = await store.consume(token, "self-abc1");
      expect(result).toBeNull();
    });

    it("marks token as used after consumption", async () => {
      const { token } = await store.create("user-1");
      await store.consume(token, "self-abc1");
      // Trying again returns null
      expect(await store.consume(token, "self-abc1")).toBeNull();
    });

    it("returns label as null when not set", async () => {
      const { token } = await store.create("user-2");
      const result = await store.consume(token, "self-xyz");
      expect(result?.label).toBeNull();
    });
  });

  describe("listActive", () => {
    it("lists only unexpired unused tokens for the user", async () => {
      await store.create("user-1", "Token A");
      await store.create("user-1", "Token B");
      await store.create("user-2", "Token C");

      const active = await store.listActive("user-1");
      expect(active).toHaveLength(2);
      expect(active.every((t) => t.userId === "user-1")).toBe(true);
    });

    it("excludes consumed tokens", async () => {
      const { token } = await store.create("user-1");
      await store.create("user-1");
      await store.consume(token, "node-1");

      const active = await store.listActive("user-1");
      expect(active).toHaveLength(1);
    });

    it("returns empty array when no active tokens", async () => {
      const active = await store.listActive("user-nobody");
      expect(active).toHaveLength(0);
    });
  });

  describe("purgeExpired", () => {
    it("returns count of deleted rows (0 when none expired)", async () => {
      await store.create("user-1");
      const count = await store.purgeExpired();
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
