import { beforeEach, describe, expect, it } from "vitest";
import type { BotBillingRepository } from "../../domain/repositories/bot-billing-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { InMemoryBotBillingRepository } from "./in-memory-bot-billing-repository.js";

describe("BotBillingRepository Contract", () => {
  runRepositoryContractTests("InMemoryBotBillingRepository", async () => {
    return new InMemoryBotBillingRepository();
  });
});

function runRepositoryContractTests(
  name: string,
  createRepo: () => Promise<BotBillingRepository> | BotBillingRepository,
) {
  describe(name, () => {
    let repo: BotBillingRepository;
    let tenantId: TenantId;

    beforeEach(async () => {
      repo = await createRepo();
      tenantId = TenantId.create("test-tenant-1");
    });

    describe("registerBot", () => {
      it("should register a new bot", async () => {
        await repo.registerBot("bot-1", tenantId, "Test Bot");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot).not.toBeNull();
        expect(bot?.id).toBe("bot-1");
        expect(bot?.name).toBe("Test Bot");
        expect(bot?.billingState).toBe("active");
        expect(bot?.tenantId.equals(tenantId)).toBe(true);
      });
    });

    describe("getBotBilling", () => {
      it("should return null for non-existent bot", async () => {
        const bot = await repo.getBotBilling("non-existent");
        expect(bot).toBeNull();
      });
    });

    describe("getActiveBotCount", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
        await repo.registerBot("bot-2", tenantId, "Bot 2");
        await repo.registerBot("bot-3", tenantId, "Bot 3");
      });

      it("should return 0 for tenant with no active bots", async () => {
        const otherTenant = TenantId.create("other-tenant");
        const count = await repo.getActiveBotCount(otherTenant);
        expect(count).toBe(0);
      });

      it("should return count of active bots", async () => {
        const count = await repo.getActiveBotCount(tenantId);
        expect(count).toBe(3);
      });

      it("should not count suspended bots", async () => {
        await repo.suspendBot("bot-1");
        const count = await repo.getActiveBotCount(tenantId);
        expect(count).toBe(2);
      });

      it("should not count destroyed bots", async () => {
        await repo.destroyBot("bot-1");
        const count = await repo.getActiveBotCount(tenantId);
        expect(count).toBe(2);
      });
    });

    describe("listForTenant", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
        await repo.registerBot("bot-2", tenantId, "Bot 2");
      });

      it("should return all bots for tenant", async () => {
        const bots = await repo.listForTenant(tenantId);
        expect(bots).toHaveLength(2);
      });

      it("should return empty for tenant with no bots", async () => {
        const otherTenant = TenantId.create("other-tenant");
        const bots = await repo.listForTenant(otherTenant);
        expect(bots).toHaveLength(0);
      });
    });

    describe("suspendBot", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
      });

      it("should suspend an active bot", async () => {
        await repo.suspendBot("bot-1");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot?.billingState).toBe("suspended");
        expect(bot?.suspendedAt).not.toBeNull();
        expect(bot?.destroyAfter).not.toBeNull();
      });

      it("should preserve name and tenant", async () => {
        await repo.suspendBot("bot-1");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot?.name).toBe("Bot 1");
        expect(bot?.tenantId.equals(tenantId)).toBe(true);
      });
    });

    describe("suspendAllForTenant", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
        await repo.registerBot("bot-2", tenantId, "Bot 2");
        const otherTenant = TenantId.create("other-tenant");
        await repo.registerBot("bot-3", otherTenant, "Bot 3");
      });

      it("should suspend all active bots for tenant", async () => {
        const suspended = await repo.suspendAllForTenant(tenantId);

        expect(suspended).toHaveLength(2);
        expect(suspended).toContain("bot-1");
        expect(suspended).toContain("bot-2");
      });

      it("should not affect other tenants", async () => {
        await repo.suspendAllForTenant(tenantId);

        const bot3 = await repo.getBotBilling("bot-3");
        expect(bot3?.billingState).toBe("active");
      });
    });

    describe("reactivateBot", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
        await repo.suspendBot("bot-1");
      });

      it("should reactivate a suspended bot", async () => {
        await repo.reactivateBot("bot-1");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot?.billingState).toBe("active");
        expect(bot?.suspendedAt).toBeNull();
        expect(bot?.destroyAfter).toBeNull();
      });

      it("should not reactivate non-suspended bots", async () => {
        await repo.registerBot("bot-2", tenantId, "Bot 2");
        await repo.reactivateBot("bot-2");

        const bot = await repo.getBotBilling("bot-2");
        expect(bot?.billingState).toBe("active");
      });
    });

    describe("getSuspendedBots", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
        await repo.registerBot("bot-2", tenantId, "Bot 2");
        await repo.registerBot("bot-3", tenantId, "Bot 3");
        await repo.suspendBot("bot-1");
        await repo.suspendBot("bot-2");
      });

      it("should return only suspended bots", async () => {
        const suspended = await repo.getSuspendedBots(tenantId);

        expect(suspended).toHaveLength(2);
        const ids = suspended.map((b) => b.id);
        expect(ids).toContain("bot-1");
        expect(ids).toContain("bot-2");
        expect(ids).not.toContain("bot-3");
      });
    });

    describe("destroyBot", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
      });

      it("should mark bot as destroyed", async () => {
        await repo.destroyBot("bot-1");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot?.billingState).toBe("destroyed");
      });

      it("should work on suspended bots", async () => {
        await repo.suspendBot("bot-1");
        await repo.destroyBot("bot-1");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot?.billingState).toBe("destroyed");
      });
    });

    describe("destroyExpiredBots", () => {
      it("should not destroy bots within grace period", async () => {
        const tenant = TenantId.create("fresh-tenant");
        await repo.registerBot("bot-1", tenant, "Bot 1");
        await repo.suspendBot("bot-1");

        const destroyed = await repo.destroyExpiredBots();
        expect(destroyed).toHaveLength(0);
      });

      it("should return empty when no suspended bots", async () => {
        const destroyed = await repo.destroyExpiredBots();
        expect(destroyed).toHaveLength(0);
      });
    });

    describe("assignToNode", () => {
      beforeEach(async () => {
        await repo.registerBot("bot-1", tenantId, "Bot 1");
      });

      it("should assign bot to node", async () => {
        await repo.assignToNode("bot-1", "node-1");

        const bot = await repo.getBotBilling("bot-1");
        expect(bot?.nodeId).toBe("node-1");
      });
    });
  });
}
