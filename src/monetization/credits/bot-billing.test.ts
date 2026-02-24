/**
 * Unit tests for BotBilling — bot lifecycle billing state management (WOP-447).
 *
 * Covers:
 * - Registering bots
 * - Active bot counting
 * - Suspension on zero balance
 * - Reactivation on credit purchase
 * - Destruction of long-suspended bots
 * - Integration with CreditLedger for reactivation checks
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { BotBilling, SUSPENSION_GRACE_DAYS } from "./bot-billing.js";
import { CreditLedger } from "./credit-ledger.js";

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
      resource_tier TEXT NOT NULL DEFAULT 'standard',
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
      funding_source TEXT,
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
  let ledger: CreditLedger;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    billing = new BotBilling(db);
    ledger = new CreditLedger(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // ---------------------------------------------------------------------------
  // registerBot / getActiveBotCount
  // ---------------------------------------------------------------------------

  describe("registerBot", () => {
    it("registers a bot in active billing state", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      const info = billing.getBotBilling("bot-1");
      expect(info).not.toBeNull();
      expect(info?.billingState).toBe("active");
      expect(info?.tenantId).toBe("tenant-1");
      expect(info?.name).toBe("my-bot");
      expect(info?.suspendedAt).toBeNull();
      expect(info?.destroyAfter).toBeNull();
    });
  });

  describe("getActiveBotCount", () => {
    it("returns 0 when no bots exist", () => {
      expect(billing.getActiveBotCount("tenant-1")).toBe(0);
    });

    it("counts only active bots for the tenant", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.registerBot("bot-2", "tenant-1", "bot-b");
      billing.registerBot("bot-3", "tenant-2", "bot-c");

      expect(billing.getActiveBotCount("tenant-1")).toBe(2);
      expect(billing.getActiveBotCount("tenant-2")).toBe(1);
    });

    it("does not count suspended bots", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.registerBot("bot-2", "tenant-1", "bot-b");
      billing.suspendBot("bot-1");

      expect(billing.getActiveBotCount("tenant-1")).toBe(1);
    });

    it("does not count destroyed bots", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.destroyBot("bot-1");

      expect(billing.getActiveBotCount("tenant-1")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // suspendBot
  // ---------------------------------------------------------------------------

  describe("suspendBot", () => {
    it("transitions bot from active to suspended", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      billing.suspendBot("bot-1");

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("suspended");
      expect(info?.suspendedAt).not.toBeNull();
      expect(info?.destroyAfter).not.toBeNull();
    });

    it("sets destroyAfter to 30 days after suspension", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      billing.suspendBot("bot-1");

      const info = billing.getBotBilling("bot-1");
      expect(info).not.toBeNull();
      const suspendedAt = new Date(info?.suspendedAt ?? "");
      const destroyAfter = new Date(info?.destroyAfter ?? "");
      const diffDays = Math.round((destroyAfter.getTime() - suspendedAt.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(SUSPENSION_GRACE_DAYS);
    });
  });

  describe("suspendAllForTenant", () => {
    it("suspends all active bots for a tenant", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.registerBot("bot-2", "tenant-1", "bot-b");
      billing.registerBot("bot-3", "tenant-2", "bot-c");

      const suspended = billing.suspendAllForTenant("tenant-1");

      expect(suspended).toEqual(["bot-1", "bot-2"]);
      expect(billing.getActiveBotCount("tenant-1")).toBe(0);
      expect(billing.getActiveBotCount("tenant-2")).toBe(1);
    });

    it("returns empty array when no active bots", () => {
      const suspended = billing.suspendAllForTenant("tenant-1");
      expect(suspended).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // reactivateBot
  // ---------------------------------------------------------------------------

  describe("reactivateBot", () => {
    it("transitions bot from suspended to active", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      billing.suspendBot("bot-1");
      billing.reactivateBot("bot-1");

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("active");
      expect(info?.suspendedAt).toBeNull();
      expect(info?.destroyAfter).toBeNull();
    });

    it("does not reactivate a destroyed bot", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      billing.destroyBot("bot-1");
      billing.reactivateBot("bot-1");

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("destroyed");
    });

    it("does not affect already-active bots", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      // reactivateBot on an active bot is a no-op (WHERE clause won't match)
      billing.reactivateBot("bot-1");

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("active");
    });
  });

  // ---------------------------------------------------------------------------
  // checkReactivation
  // ---------------------------------------------------------------------------

  describe("checkReactivation", () => {
    it("reactivates suspended bots when balance is positive", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.registerBot("bot-2", "tenant-1", "bot-b");
      billing.suspendBot("bot-1");
      billing.suspendBot("bot-2");

      ledger.credit("tenant-1", 500, "purchase", "test credit");
      const reactivated = billing.checkReactivation("tenant-1", ledger);

      expect(reactivated).toEqual(["bot-1", "bot-2"]);
      expect(billing.getActiveBotCount("tenant-1")).toBe(2);
    });

    it("does not reactivate when balance is zero", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.suspendBot("bot-1");

      const reactivated = billing.checkReactivation("tenant-1", ledger);
      expect(reactivated).toEqual([]);
      expect(billing.getActiveBotCount("tenant-1")).toBe(0);
    });

    it("does not reactivate destroyed bots", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.destroyBot("bot-1");

      ledger.credit("tenant-1", 500, "purchase", "test credit");
      const reactivated = billing.checkReactivation("tenant-1", ledger);

      expect(reactivated).toEqual([]);
    });

    it("returns empty array for tenant with no bots", () => {
      ledger.credit("tenant-1", 500, "purchase", "test credit");
      const reactivated = billing.checkReactivation("tenant-1", ledger);
      expect(reactivated).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // destroyBot / destroyExpiredBots
  // ---------------------------------------------------------------------------

  describe("destroyBot", () => {
    it("marks bot as destroyed", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      billing.destroyBot("bot-1");

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("destroyed");
    });
  });

  describe("destroyExpiredBots", () => {
    it("destroys bots past their grace period", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");

      // Manually set destroyAfter to the past to simulate expiration
      sqlite.exec(`
        UPDATE bot_instances
        SET billing_state = 'suspended',
            suspended_at = datetime('now', '-31 days'),
            destroy_after = datetime('now', '-1 day')
        WHERE id = 'bot-1'
      `);

      const destroyed = billing.destroyExpiredBots();
      expect(destroyed).toEqual(["bot-1"]);

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("destroyed");
    });

    it("does not destroy bots still within grace period", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.suspendBot("bot-1");

      // destroyAfter is 30 days in the future, should not be destroyed
      const destroyed = billing.destroyExpiredBots();
      expect(destroyed).toEqual([]);

      const info = billing.getBotBilling("bot-1");
      expect(info?.billingState).toBe("suspended");
    });

    it("does not touch active bots", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");

      const destroyed = billing.destroyExpiredBots();
      expect(destroyed).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // listForTenant
  // ---------------------------------------------------------------------------

  describe("listForTenant", () => {
    it("lists all bots regardless of billing state", () => {
      billing.registerBot("bot-1", "tenant-1", "bot-a");
      billing.registerBot("bot-2", "tenant-1", "bot-b");
      billing.registerBot("bot-3", "tenant-2", "bot-c");
      billing.suspendBot("bot-2");

      const bots = billing.listForTenant("tenant-1");
      expect(bots).toHaveLength(2);
      expect(bots.map((b) => b.id).sort()).toEqual(["bot-1", "bot-2"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("active -> suspended -> reactivated -> active", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      expect(billing.getBotBilling("bot-1")?.billingState).toBe("active");

      billing.suspendBot("bot-1");
      expect(billing.getBotBilling("bot-1")?.billingState).toBe("suspended");

      billing.reactivateBot("bot-1");
      expect(billing.getBotBilling("bot-1")?.billingState).toBe("active");
      expect(billing.getBotBilling("bot-1")?.suspendedAt).toBeNull();
      expect(billing.getBotBilling("bot-1")?.destroyAfter).toBeNull();
    });

    it("active -> suspended -> destroyed (after grace period)", () => {
      billing.registerBot("bot-1", "tenant-1", "my-bot");
      billing.suspendBot("bot-1");

      // Simulate grace period expiration
      sqlite.exec(`
        UPDATE bot_instances
        SET destroy_after = datetime('now', '-1 day')
        WHERE id = 'bot-1'
      `);

      billing.destroyExpiredBots();
      expect(billing.getBotBilling("bot-1")?.billingState).toBe("destroyed");
    });
  });
});
