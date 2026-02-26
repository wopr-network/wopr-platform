import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleBotInstanceRepository } from "../../fleet/drizzle-bot-instance-repository.js";
import { DrizzleNodeRepository } from "../../fleet/drizzle-node-repository.js";
import { NodeConnectionRegistry } from "../../fleet/node-connection-registry.js";
import { RegistrationTokenStore } from "../../fleet/registration-token-store.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { nodesRouter, setNodesRouterDeps } from "./nodes.js";

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
  let pool: PGlite;

  beforeAll(async () => {
    const testDb = await createTestDb();
    pool = testDb.pool;
    const db = testDb.db;
    tokenStore = new RegistrationTokenStore(db);
    nodeRepo = new DrizzleNodeRepository(db);
    registry = new NodeConnectionRegistry();
    botInstanceRepo = new DrizzleBotInstanceRepository(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
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

      const active = await tokenStore.listActive("user-42");
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
      await nodeRepo.registerSelfHosted({
        nodeId: "self-aaa111",
        host: "192.168.1.1",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "Node A",
        nodeSecretHash: "hash-aaa",
      });
      await nodeRepo.registerSelfHosted({
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
      await nodeRepo.registerSelfHosted({
        nodeId: "self-aaa111",
        host: "192.168.1.1",
        capacityMb: 8192,
        agentVersion: "1.0.0",
        ownerUserId: "user-1",
        label: "Node A",
        nodeSecretHash: "hash-aaa",
      });
      await nodeRepo.registerSelfHosted({
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
      await nodeRepo.registerSelfHosted({
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
      await nodeRepo.registerSelfHosted({
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
      await nodeRepo.registerSelfHosted({
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
      await nodeRepo.registerSelfHosted({
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
      const node = await nodeRepo.getById("self-fff666");
      expect(node).toBeNull();
    });

    it("throws FORBIDDEN when removing another user's node", async () => {
      await nodeRepo.registerSelfHosted({
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
      await tokenStore.create("user-1", "Token A");
      await tokenStore.create("user-1", "Token B");
      await tokenStore.create("user-2", "Token C");

      const caller = makeCaller(makeCtx("user-1"));
      const result = await caller.listTokens();

      expect(result).toHaveLength(2);
      expect(result.every((t) => t.userId === "user-1")).toBe(true);
    });
  });
});
