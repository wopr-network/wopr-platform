import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema/index.js";
import { RegistrationTokenStore } from "../../fleet/registration-token-store.js";

/**
 * Tests for token-based registration in internal-nodes route.
 *
 * We test the logic directly rather than spinning up a full Hono app
 * to keep tests fast and focused.
 */

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
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      capacity_mb INTEGER NOT NULL,
      used_mb INTEGER NOT NULL DEFAULT 0,
      agent_version TEXT,
      last_heartbeat_at INTEGER,
      registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      droplet_id TEXT,
      region TEXT,
      size TEXT,
      monthly_cost_cents INTEGER,
      provision_stage TEXT,
      last_error TEXT,
      drain_status TEXT,
      drain_migrated INTEGER,
      drain_total INTEGER,
      owner_user_id TEXT,
      node_secret TEXT,
      label TEXT
    );
  `);
  return drizzle(sqlite, { schema });
}

describe("RegistrationTokenStore integration with node registration", () => {
  let tokenStore: RegistrationTokenStore;

  beforeEach(() => {
    tokenStore = new RegistrationTokenStore(makeDb());
  });

  it("creates a valid token that can be consumed once", () => {
    const { token } = tokenStore.create("user-abc", "Test Node");
    const result = tokenStore.consume(token, "self-node-1");
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-abc");
    expect(result?.label).toBe("Test Node");
  });

  it("token cannot be consumed twice (replay prevention)", () => {
    const { token } = tokenStore.create("user-abc");
    tokenStore.consume(token, "self-node-1");
    const result = tokenStore.consume(token, "self-node-2");
    expect(result).toBeNull();
  });

  it("invalid token returns null", () => {
    const result = tokenStore.consume("not-a-real-token", "self-node-1");
    expect(result).toBeNull();
  });

  it("listActive excludes consumed tokens", () => {
    const { token: t1 } = tokenStore.create("user-abc", "Node A");
    const { token: t2 } = tokenStore.create("user-abc", "Node B");
    tokenStore.consume(t1, "self-node-1");

    const active = tokenStore.listActive("user-abc");
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
