import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleOAuthStateRepository } from "./drizzle-oauth-state-repository.js";

describe("DrizzleOAuthStateRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleOAuthStateRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleOAuthStateRepository(db);
  });

  it("creates and consumes a pending state", async () => {
    await repo.create({
      state: "test-uuid",
      provider: "slack",
      userId: "user-1",
      redirectUri: "https://example.com/cb",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });

    const consumed = await repo.consumePending("test-uuid");
    expect(consumed).not.toBeNull();
    expect(consumed?.provider).toBe("slack");

    const again = await repo.consumePending("test-uuid");
    expect(again).toBeNull();
  });

  it("stores and retrieves completed token", async () => {
    await repo.create({
      state: "s1",
      provider: "slack",
      userId: "user-1",
      redirectUri: "https://example.com/cb",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });

    await repo.completeWithToken("s1", "tok_abc", "user-1");

    const result = await repo.consumeCompleted("s1", "user-1");
    expect(result).not.toBeNull();
    expect(result?.token).toBe("tok_abc");

    const again = await repo.consumeCompleted("s1", "user-1");
    expect(again).toBeNull();
  });

  it("returns null for expired state", async () => {
    await repo.create({
      state: "expired",
      provider: "slack",
      userId: "user-1",
      redirectUri: "https://example.com/cb",
      createdAt: Date.now() - 700_000,
      expiresAt: Date.now() - 100_000,
    });

    const result = await repo.consumePending("expired");
    expect(result).toBeNull();
  });
});
