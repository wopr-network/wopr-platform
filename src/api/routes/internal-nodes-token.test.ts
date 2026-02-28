import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { RegistrationTokenStore } from "../../fleet/registration-token-store.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";

/**
 * Tests for token-based registration in internal-nodes route.
 *
 * We test the logic directly rather than spinning up a full Hono app
 * to keep tests fast and focused.
 */

let db: DrizzleDb;
let pool: PGlite;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("RegistrationTokenStore integration with node registration", () => {
  let tokenStore: RegistrationTokenStore;

  beforeEach(async () => {
    await truncateAllTables(pool);
    tokenStore = new RegistrationTokenStore(db);
  });

  it("creates a valid token that can be consumed once", async () => {
    const { token } = await tokenStore.create("user-abc", "Test Node");
    const result = await tokenStore.consume(token, "self-node-1");
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-abc");
    expect(result?.label).toBe("Test Node");
  });

  it("token cannot be consumed twice (replay prevention)", async () => {
    const { token } = await tokenStore.create("user-abc");
    await tokenStore.consume(token, "self-node-1");
    const result = await tokenStore.consume(token, "self-node-2");
    expect(result).toBeNull();
  });

  it("invalid token returns null", async () => {
    const result = await tokenStore.consume("not-a-real-token", "self-node-1");
    expect(result).toBeNull();
  });

  it("listActive excludes consumed tokens", async () => {
    const { token: t1 } = await tokenStore.create("user-abc", "Node A");
    const { token: t2 } = await tokenStore.create("user-abc", "Node B");
    await tokenStore.consume(t1, "self-node-1");

    const active = await tokenStore.listActive("user-abc");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(t2);
  });
});

describe("Bearer token pattern matching", () => {
  it("UUID-format string matches registration token pattern", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(uuidPattern.test(uuid)).toBe(true);
  });

  it("non-UUID strings do not match UUID pattern", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidPattern.test("static-secret-123")).toBe(false);
    expect(uuidPattern.test("wopr_node_abc123")).toBe(false);
  });

  it("wopr_node_ prefixed secret is not a UUID", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const nodeSecret = "wopr_node_abc1234567890";
    expect(uuidPattern.test(nodeSecret)).toBe(false);
  });
});
