/**
 * Unit tests for BotBilling — bot lifecycle billing state management (WOP-447).
 *
 * Covers:
 * - Registering bots
 * - Active bot counting
 * - Suspension on zero balance
 * - Reactivation on credit purchase
 * - Destruction of long-suspended bots
 * - Integration with CreditRepository for reactivation checks
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { BotBilling, SUSPENSION_GRACE_DAYS } from "./bot-billing.js";
import { InMemoryCreditRepository } from "../../infrastructure/persistence/in-memory-credit-repository.js";
import { InMemoryBotBillingRepository } from "../../infrastructure/persistence/in-memory-bot-billing-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { Money } from "../../domain/value-objects/money.js";
import type { CreditRepository } from "../../domain/repositories/credit-repository.js";

/** Initialize schemas required for testing. */
function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_bot_instances_tenant ON bot_instances(tenant_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_bot_instances_billing_state ON bot_instances(billing_state)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_bot_instances_destroy_after ON bot_instances(destroy_after)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_bot_instances_node ON bot_instances(node_id)");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

describe("BotBilling", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let billing: BotBilling;
  let repository: InMemoryBotBillingRepository;
  let creditRepository: CreditRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    repository = new InMemoryBotBillingRepository();
    billing = new BotBilling(repository);
    creditRepository = new InMemoryCreditRepository();
  });

  afterEach(() => {
    sqlite.close();
  });

  // ---------------------------------------------------------------------------
  // registerBot / getActiveBotCount
  // ---------------------------------------------------------------------------

  describe("registerBot", () => {
    it("registers a bot in active billing state", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      const info = await billing.getBotBilling("bot-1");
      expect(info).not.toBeNull();
      expect(info?.billingState).toBe("active");
      expect(info?.tenantId.toString()).toBe("tenant-1");
      expect(info?.name).toBe("my-bot");
      expect(info?.suspendedAt).toBeNull();
      expect(info?.destroyAfter).toBeNull();
    });
  });

  describe("getActiveBotCount", () => {
    it("returns 0 when no bots exist", async () => {
      const count = await billing.getActiveBotCount("tenant-1");
      expect(count).toBe(0);
    });

    it("counts only active bots for the tenant", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.registerBot("bot-3", "tenant-2", "bot-c");

      const count1 = await billing.getActiveBotCount("tenant-1");
      const count2 = await billing.getActiveBotCount("tenant-2");
      expect(count1).toBe(2);
      expect(count2).toBe(1);
    });

    it("does not count suspended bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.suspendBot("bot-1");

      const count = await billing.getActiveBotCount("tenant-1");
      expect(count).toBe(1);
    });

    it("does not count destroyed bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.destroyBot("bot-1");

      const count = await billing.getActiveBotCount("tenant-1");
      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // suspendBot
  // ---------------------------------------------------------------------------

  describe("suspendBot", () => {
    it("transitions bot from active to suspended", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("suspended");
      expect(info?.suspendedAt).not.toBeNull();
      expect(info?.destroyAfter).not.toBeNull();
    });

    it("sets destroyAfter to 30 days after suspension", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info).not.toBeNull();
      const suspendedAt = info!.suspendedAt!;
      const destroyAfter = info!.destroyAfter!;
      const diffDays = Math.round((destroyAfter.getTime() - suspendedAt.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(SUSPENSION_GRACE_DAYS);
    });
  });

  describe("suspendAllForTenant", () => {
    it("suspends all active bots for a tenant", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.registerBot("bot-3", "tenant-2", "bot-c");

      const suspended = await billing.suspendAllForTenant("tenant-1");

      expect(suspended).toEqual(["bot-1", "bot-2"]);
      expect(await billing.getActiveBotCount("tenant-1")).toBe(0);
      expect(await billing.getActiveBotCount("tenant-2")).toBe(1);
    });

    it("returns empty array when no active bots", async () => {
      const suspended = await billing.suspendAllForTenant("tenant-1");
      expect(suspended).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // reactivateBot
  // ---------------------------------------------------------------------------

  describe("reactivateBot", () => {
    it("transitions bot from suspended to active", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");
      await billing.reactivateBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("active");
      expect(info?.suspendedAt).toBeNull();
      expect(info?.destroyAfter).toBeNull();
    });

    it("does not reactivate a destroyed bot", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.destroyBot("bot-1");
      await billing.reactivateBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("destroyed");
    });

    it("does not affect already-active bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.reactivateBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("active");
    });
  });

  // ---------------------------------------------------------------------------
  // checkReactivation
  // ---------------------------------------------------------------------------

  describe("checkReactivation", () => {
    it("reactivates suspended bots when balance is positive", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.suspendBot("bot-1");
      await billing.suspendBot("bot-2");

      await creditRepository.credit(TenantId.create("tenant-1"), Money.fromCents(500), "purchase", "test credit");
      const reactivated = await billing.checkReactivation("tenant-1", creditRepository);

      expect(reactivated).toEqual(["bot-1", "bot-2"]);
      expect(await billing.getActiveBotCount("tenant-1")).toBe(2);
    });

    it("does not reactivate when balance is zero", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.suspendBot("bot-1");

      const reactivated = await billing.checkReactivation("tenant-1", creditRepository);
      expect(reactivated).toEqual([]);
      expect(await billing.getActiveBotCount("tenant-1")).toBe(0);
    });

    it("does not reactivate destroyed bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.destroyBot("bot-1");

      await creditRepository.credit(TenantId.create("tenant-1"), Money.fromCents(500), "purchase", "test credit");
      const reactivated = await billing.checkReactivation("tenant-1", creditRepository);

      expect(reactivated).toEqual([]);
    });

    it("returns empty array for tenant with no bots", async () => {
      await creditRepository.credit(TenantId.create("tenant-1"), Money.fromCents(500), "purchase", "test credit");
      const reactivated = await billing.checkReactivation("tenant-1", creditRepository);
      expect(reactivated).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // destroyBot / destroyExpiredBots
  // ---------------------------------------------------------------------------

  describe("destroyBot", () => {
    it("marks bot as destroyed", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.destroyBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("destroyed");
    });
  });

  describe("destroyExpiredBots", () => {
    it("destroys bots past their grace period", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.suspendBot("bot-1");

      // Set destroyAfter to past date via repository
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1);
      repository.setDestroyAfter("bot-1", expiredDate);

      const destroyed = await billing.destroyExpiredBots();
      expect(destroyed).toEqual(["bot-1"]);

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("destroyed");
    });

    it("does not destroy bots still within grace period", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.suspendBot("bot-1");

      // destroyAfter is 30 days in the future, should not be destroyed
      const destroyed = await billing.destroyExpiredBots();
      expect(destroyed).toEqual([]);

      const info = await billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("suspended");
    });

    it("does not touch active bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");

      const destroyed = await billing.destroyExpiredBots();
      expect(destroyed).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // listForTenant
  // ---------------------------------------------------------------------------

  describe("listForTenant", () => {
    it("lists all bots regardless of billing state", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.registerBot("bot-3", "tenant-2", "bot-c");
      await billing.suspendBot("bot-2");

      const bots = await billing.listForTenant("tenant-1");
      expect(bots).toHaveLength(2);
      expect(bots.map((b) => b.id).sort()).toEqual(["bot-1", "bot-2"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("active -> suspended -> reactivated -> active", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      expect((await billing.getBotBilling("bot-1"))?.billingState).toBe("active");

      await billing.suspendBot("bot-1");
      expect((await billing.getBotBilling("bot-1"))?.billingState).toBe("suspended");

      await billing.reactivateBot("bot-1");
      expect((await billing.getBotBilling("bot-1"))?.billingState).toBe("active");
      expect((await billing.getBotBilling("bot-1"))?.suspendedAt).toBeNull();
      expect((await billing.getBotBilling("bot-1"))?.destroyAfter).toBeNull();
    });

    it("active -> suspended -> destroyed (after grace period)", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");

      // Set destroyAfter to past date to simulate grace period expiration
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1);
      repository.setDestroyAfter("bot-1", expiredDate);

      await billing.destroyExpiredBots();
      expect((await billing.getBotBilling("bot-1"))?.billingState).toBe("destroyed");
    });
  });
});
