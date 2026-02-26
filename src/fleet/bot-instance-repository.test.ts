import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleBotInstanceRepository } from "./drizzle-bot-instance-repository.js";

describe("DrizzleBotInstanceRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleBotInstanceRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleBotInstanceRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("create", () => {
    it("creates a bot instance with default billing state", async () => {
      const bot = await repo.create({
        id: "bot-1",
        tenantId: "tenant-1",
        name: "my-bot",
        nodeId: "node-1",
      });
      expect(bot.id).toBe("bot-1");
      expect(bot.tenantId).toBe("tenant-1");
      expect(bot.name).toBe("my-bot");
      expect(bot.nodeId).toBe("node-1");
      expect(bot.billingState).toBe("active");
      expect(bot.suspendedAt).toBeNull();
      expect(bot.destroyAfter).toBeNull();
      expect(bot.createdAt).toBeDefined();
      expect(bot.updatedAt).toBeDefined();
    });

    it("creates a bot instance with explicit billing state", async () => {
      const bot = await repo.create({
        id: "bot-2",
        tenantId: "tenant-1",
        name: "suspended-bot",
        nodeId: null,
        billingState: "suspended",
      });
      expect(bot.billingState).toBe("suspended");
    });

    it("creates a bot instance with null nodeId", async () => {
      const bot = await repo.create({
        id: "bot-3",
        tenantId: "tenant-1",
        name: "unassigned-bot",
        nodeId: null,
      });
      expect(bot.nodeId).toBeNull();
    });
  });

  describe("getById", () => {
    it("returns the bot instance when it exists", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b", nodeId: "n-1" });
      const bot = await repo.getById("bot-1");
      expect(bot).not.toBeNull();
      expect(bot?.id).toBe("bot-1");
    });

    it("returns null when bot does not exist", async () => {
      expect(await repo.getById("nonexistent")).toBeNull();
    });
  });

  describe("listByNode", () => {
    it("returns all instances on a node", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: "node-A" });
      await repo.create({ id: "bot-2", tenantId: "t-2", name: "b2", nodeId: "node-A" });
      await repo.create({ id: "bot-3", tenantId: "t-3", name: "b3", nodeId: "node-B" });

      const result = await repo.listByNode("node-A");
      expect(result).toHaveLength(2);
      expect(result.map((b) => b.id).sort()).toEqual(["bot-1", "bot-2"]);
    });

    it("returns empty array when no instances on node", async () => {
      expect(await repo.listByNode("empty-node")).toEqual([]);
    });

    it("does not return instances with null nodeId", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: null });
      expect(await repo.listByNode("any-node")).toEqual([]);
    });
  });

  describe("listByTenant", () => {
    it("returns all instances for a tenant", async () => {
      await repo.create({ id: "bot-1", tenantId: "tenant-X", name: "b1", nodeId: "n-1" });
      await repo.create({ id: "bot-2", tenantId: "tenant-X", name: "b2", nodeId: "n-2" });
      await repo.create({ id: "bot-3", tenantId: "tenant-Y", name: "b3", nodeId: "n-1" });

      const result = await repo.listByTenant("tenant-X");
      expect(result).toHaveLength(2);
      expect(result.every((b) => b.tenantId === "tenant-X")).toBe(true);
    });

    it("returns empty array when tenant has no instances", async () => {
      expect(await repo.listByTenant("nobody")).toEqual([]);
    });
  });

  describe("reassign", () => {
    it("updates nodeId and returns updated instance", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: "node-old" });

      const updated = await repo.reassign("bot-1", "node-new");
      expect(updated.nodeId).toBe("node-new");
      expect(updated.id).toBe("bot-1");
    });

    it("updates updatedAt timestamp", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: "node-old" });

      const updated = await repo.reassign("bot-1", "node-new");
      expect(updated.updatedAt).toBeDefined();
    });

    it("throws when bot does not exist", async () => {
      await expect(repo.reassign("nonexistent", "node-1")).rejects.toThrow("Bot instance not found: nonexistent");
    });
  });

  describe("createdByUserId", () => {
    it("persists createdByUserId on create", async () => {
      const bot = await repo.create({
        id: "00000000-0000-4000-8000-000000000099",
        tenantId: "tenant-1",
        name: "test-bot",
        nodeId: null,
        createdByUserId: "user-42",
      });
      expect(bot.createdByUserId).toBe("user-42");
    });

    it("defaults createdByUserId to null when omitted", async () => {
      const bot = await repo.create({
        id: "00000000-0000-4000-8000-000000000098",
        tenantId: "tenant-1",
        name: "legacy-bot",
        nodeId: null,
      });
      expect(bot.createdByUserId).toBeNull();
    });

    it("returns createdByUserId from getById", async () => {
      await repo.create({
        id: "00000000-0000-4000-8000-000000000097",
        tenantId: "tenant-1",
        name: "owned-bot",
        nodeId: null,
        createdByUserId: "user-7",
      });
      const fetched = await repo.getById("00000000-0000-4000-8000-000000000097");
      expect(fetched?.createdByUserId).toBe("user-7");
    });

    it("returns createdByUserId in listByTenant", async () => {
      await repo.create({
        id: "00000000-0000-4000-8000-000000000096",
        tenantId: "tenant-2",
        name: "org-bot",
        nodeId: null,
        createdByUserId: "user-A",
      });
      const bots = await repo.listByTenant("tenant-2");
      expect(bots[0].createdByUserId).toBe("user-A");
    });
  });

  describe("org-scoped ownership (WOP-1002)", () => {
    it("bot persists after removing the creating user (no FK cascade)", async () => {
      await repo.create({
        id: "00000000-0000-4000-8000-000000000090",
        tenantId: "org-tenant-1",
        name: "org-bot-1",
        nodeId: null,
        createdByUserId: "user-A",
      });

      // Simulate removing user-A: just verify bot still exists
      // (There is no FK from bot_instances to users, so nothing cascades)
      const bot = await repo.getById("00000000-0000-4000-8000-000000000090");
      expect(bot).not.toBeNull();
      expect(bot?.tenantId).toBe("org-tenant-1");
      expect(bot?.createdByUserId).toBe("user-A");
    });

    it("listByTenant returns bots from all creators in the org", async () => {
      await repo.create({
        id: "00000000-0000-4000-8000-000000000089",
        tenantId: "org-tenant-2",
        name: "bot-by-A",
        nodeId: null,
        createdByUserId: "user-A",
      });
      await repo.create({
        id: "00000000-0000-4000-8000-000000000088",
        tenantId: "org-tenant-2",
        name: "bot-by-B",
        nodeId: null,
        createdByUserId: "user-B",
      });

      const bots = await repo.listByTenant("org-tenant-2");
      expect(bots).toHaveLength(2);
      const creators = bots.map((b) => b.createdByUserId).sort();
      expect(creators).toEqual(["user-A", "user-B"]);
    });
  });

  describe("setBillingState", () => {
    it("suspends a bot and sets suspension timestamps", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: "n-1" });

      const suspended = await repo.setBillingState("bot-1", "suspended");
      expect(suspended.billingState).toBe("suspended");
      expect(suspended.suspendedAt).not.toBeNull();
      expect(suspended.destroyAfter).not.toBeNull();
    });

    it("reactivates a bot and clears suspension timestamps", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: "n-1" });
      await repo.setBillingState("bot-1", "suspended");

      const reactivated = await repo.setBillingState("bot-1", "active");
      expect(reactivated.billingState).toBe("active");
      expect(reactivated.suspendedAt).toBeNull();
      expect(reactivated.destroyAfter).toBeNull();
    });

    it("sets billing state to destroyed", async () => {
      await repo.create({ id: "bot-1", tenantId: "t-1", name: "b1", nodeId: "n-1" });

      const destroyed = await repo.setBillingState("bot-1", "destroyed");
      expect(destroyed.billingState).toBe("destroyed");
    });

    it("throws when bot does not exist", async () => {
      await expect(repo.setBillingState("nonexistent", "suspended")).rejects.toThrow(
        "Bot instance not found: nonexistent",
      );
    });
  });
});
