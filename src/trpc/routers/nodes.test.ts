import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema/index.js";
import { DrizzleBotInstanceRepository } from "../../fleet/drizzle-bot-instance-repository.js";
import { DrizzleNodeRepository } from "../../fleet/drizzle-node-repository.js";
import { NodeConnectionRegistry } from "../../fleet/node-connection-registry.js";
import { RegistrationTokenStore } from "../../fleet/registration-token-store.js";
import { nodesRouter, setNodesRouterDeps } from "./nodes.js";

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
    CREATE TABLE IF NOT EXISTS node_transitions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      resource_tier TEXT NOT NULL DEFAULT 'standard',
      storage_tier TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_user_id TEXT
    );
  `);
  return drizzle(sqlite, { schema });
}

function makeCtx(userId: string, roles: string[] = []) {
  return {
    user: { id: userId, roles },
    tenantId: undefined as string | undefined,
  };
}

function makeCaller(ctx: ReturnType<typeof makeCtx>) {
  return nodesRouter.createCaller(ctx);
}

describe("nodesRouter", () => {
  let tokenStore: RegistrationTokenStore;
  let nodeRepo: DrizzleNodeRepository;
  let registry: NodeConnectionRegistry;
  let botInstanceRepo: DrizzleBotInstanceRepository;

  beforeEach(() => {
    const db = makeDb();
    tokenStore = new RegistrationTokenStore(db);
    nodeRepo = new DrizzleNodeRepository(db);
    registry = new NodeConnectionRegistry();
    botInstanceRepo = new DrizzleBotInstanceRepository(db);

    setNodesRouterDeps({
      getRegistrationTokenStore: () => tokenStore,
      getNodeRepo: () => nodeRepo,
      getConnectionRegistry: () => registry,
      getBotInstanceRepo: () => botInstanceRepo,
    });
  });

  describe("createRegistrationToken", () => {
    it("returns a token, expiresAt, and installCommand", async () => {
      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.createRegistrationToken({ label: "Mac Mini" });

      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(result.installCommand).toContain(result.token);
      expect(result.npmCommand).toContain(result.token);
    });

    it("creates token for the authenticated user", async () => {
      const caller = makeCaller(makeCtx("user-42"));
      const result = await caller.createRegistrationToken({});

      const active = tokenStore.listActive("user-42");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(result.token);
    });
  });

  describe("list", () => {
    it("returns empty array when no nodes", async () => {
      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.list();
      expect(result).toEqual([]);
    });

    it("returns only nodes owned by the current user (non-admin)", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-aaa111",
        host: "192.168.1.1",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "Node A",
        nodeSecretHash: "hash-aaa",
      });
      nodeRepo.registerSelfHosted({
        nodeId: "self-bbb222",
        host: "192.168.1.2",
        capacityMb: 4096,
        agentVersion: "1.0.0",
        ownerUserId: "user-2",
        label: "Node B",
        nodeSecretHash: "hash-bbb",
      });

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.list();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("self-aaa111");
    });

    it("returns all nodes for platform_admin", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-aaa111",
        host: "192.168.1.1",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "Node A",
        nodeSecretHash: "hash-aaa",
      });
      nodeRepo.registerSelfHosted({
        nodeId: "self-bbb222",
        host: "192.168.1.2",
        capacityMb: 4096,
        agentVersion: "1.0.0",
        ownerUserId: "user-2",
        label: "Node B",
        nodeSecretHash: "hash-bbb",
      });

      const caller = makeCaller(makeCtx("admin-user", ["platform_admin"]));
      const result = await caller.list();

      expect(result).toHaveLength(2);
    });

    it("includes connection status and required fields", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-ccc333",
        host: "10.0.0.1",
        capacityMb: 16384,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "Home Server",
        nodeSecretHash: "hash-ccc",
      });

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.list();

      expect(result[0]).toMatchObject({
        id: "self-ccc333",
        label: "Home Server",
        host: "10.0.0.1",
        status: "active",
        isConnected: false,
        capacityMb: 16384,
      });
    });
  });

  describe("get", () => {
    it("returns node detail for owner", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-ddd444",
        host: "192.168.1.5",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "My Node",
        nodeSecretHash: "hash-ddd",
      });

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.get({ nodeId: "self-ddd444" });

      expect(result.id).toBe("self-ddd444");
      expect(result.isConnected).toBe(false);
    });

    it("throws NOT_FOUND for non-existent node", async () => {
      const caller = makeCaller(makeCtx("user-1"));
      await expect(caller.get({ nodeId: "self-doesnotexist" })).rejects.toThrow("Node not found");
    });

    it("throws NOT_FOUND when accessing another user's node", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-eee555",
        host: "192.168.1.6",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-2",
        label: "Not My Node",
        nodeSecretHash: "hash-eee",
      });

      const caller = makeCaller(makeCtx("user-1"));
      await expect(caller.get({ nodeId: "self-eee555" })).rejects.toThrow("Node not found");
    });
  });

  describe("remove", () => {
    it("removes a node successfully when no tenants", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-fff666",
        host: "192.168.1.7",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "Removable Node",
        nodeSecretHash: "hash-fff",
      });

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.remove({ nodeId: "self-fff666" });

      expect(result.success).toBe(true);
      // Node should be deleted from the DB after removal
      const node = nodeRepo.getById("self-fff666");
      expect(node).toBeNull();
    });

    it("throws FORBIDDEN when removing another user's node", async () => {
      nodeRepo.registerSelfHosted({
        nodeId: "self-ggg777",
        host: "192.168.1.8",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-2",
        label: "Another's Node",
        nodeSecretHash: "hash-ggg",
      });

      const caller = makeCaller(makeCtx("user-1"));
      await expect(caller.remove({ nodeId: "self-ggg777" })).rejects.toThrow("Not your node");
    });

    it("throws NOT_FOUND for non-existent node", async () => {
      const caller = makeCaller(makeCtx("user-1"));
      await expect(caller.remove({ nodeId: "self-doesnotexist" })).rejects.toThrow("Node not found");
    });
  });

  describe("listTokens", () => {
    it("returns active tokens for the current user", async () => {
      tokenStore.create("user-1", "Token A");
      tokenStore.create("user-1", "Token B");
      tokenStore.create("user-2", "Token C");

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.listTokens();

      expect(result).toHaveLength(2);
      expect(result.every((t) => t.userId === "user-1")).toBe(true);
    });
  });
});
