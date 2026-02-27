import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { botInstances } from "../../db/schema/bot-instances.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { BotBilling, SUSPENSION_GRACE_DAYS } from "./bot-billing.js";
import { CreditLedger } from "./credit-ledger.js";

describe("BotBilling", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let billing: BotBilling;
  let ledger: CreditLedger;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    billing = new BotBilling(db);
    ledger = new CreditLedger(db);
  });

  describe("registerBot", () => {
    it("registers a bot in active billing state", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      const info = await billing.getBotBilling("bot-1");
      expect(info).not.toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("active");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.tenantId).toBe("tenant-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.name).toBe("my-bot");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.suspendedAt).toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.destroyAfter).toBeNull();
    });
  });

  describe("getActiveBotCount", () => {
    it("returns 0 when no bots exist", async () => {
      expect(await billing.getActiveBotCount("tenant-1")).toBe(0);
    });

    it("counts only active bots for the tenant", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.registerBot("bot-3", "tenant-2", "bot-c");

      expect(await billing.getActiveBotCount("tenant-1")).toBe(2);
      expect(await billing.getActiveBotCount("tenant-2")).toBe(1);
    });

    it("does not count suspended bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.suspendBot("bot-1");

      expect(await billing.getActiveBotCount("tenant-1")).toBe(1);
    });

    it("does not count destroyed bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.destroyBot("bot-1");

      expect(await billing.getActiveBotCount("tenant-1")).toBe(0);
    });
  });

  describe("suspendBot", () => {
    it("transitions bot from active to suspended", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("suspended");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.suspendedAt).not.toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.destroyAfter).not.toBeNull();
    });

    it("sets destroyAfter to 30 days after suspension", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      expect(info).not.toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      const suspendedAt = new Date((info as any)?.suspendedAt ?? "");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      const destroyAfter = new Date((info as any)?.destroyAfter ?? "");
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

      expect(suspended.sort()).toEqual(["bot-1", "bot-2"]);
      expect(await billing.getActiveBotCount("tenant-1")).toBe(0);
      expect(await billing.getActiveBotCount("tenant-2")).toBe(1);
    });

    it("returns empty array when no active bots", async () => {
      const suspended = await billing.suspendAllForTenant("tenant-1");
      expect(suspended).toEqual([]);
    });
  });

  describe("reactivateBot", () => {
    it("transitions bot from suspended to active", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");
      await billing.reactivateBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("active");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.suspendedAt).toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.destroyAfter).toBeNull();
    });

    it("does not reactivate a destroyed bot", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.destroyBot("bot-1");
      await billing.reactivateBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("destroyed");
    });

    it("does not affect already-active bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.reactivateBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("active");
    });
  });

  describe("checkReactivation", () => {
    it("reactivates suspended bots when balance is positive", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.suspendBot("bot-1");
      await billing.suspendBot("bot-2");

      await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "test credit", "ref-1", "stripe");
      const reactivated = await billing.checkReactivation("tenant-1", ledger);

      expect(reactivated.sort()).toEqual(["bot-1", "bot-2"]);
      expect(await billing.getActiveBotCount("tenant-1")).toBe(2);
    });

    it("does not reactivate when balance is zero", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.suspendBot("bot-1");

      const reactivated = await billing.checkReactivation("tenant-1", ledger);
      expect(reactivated).toEqual([]);
      expect(await billing.getActiveBotCount("tenant-1")).toBe(0);
    });

    it("does not reactivate destroyed bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.destroyBot("bot-1");

      await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "test credit", "ref-1", "stripe");
      const reactivated = await billing.checkReactivation("tenant-1", ledger);

      expect(reactivated).toEqual([]);
    });

    it("returns empty array for tenant with no bots", async () => {
      await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "test credit", "ref-1", "stripe");
      const reactivated = await billing.checkReactivation("tenant-1", ledger);
      expect(reactivated).toEqual([]);
    });
  });

  describe("destroyBot", () => {
    it("marks bot as destroyed", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.destroyBot("bot-1");

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("destroyed");
    });
  });

  describe("destroyExpiredBots", () => {
    it("destroys bots past their grace period", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");

      // Set destroyAfter to the past using drizzle sql
      await db
        .update(botInstances)
        .set({
          billingState: "suspended",
          suspendedAt: sql`now() - interval '31 days'`,
          destroyAfter: sql`now() - interval '1 day'`,
        })
        .where(sql`id = 'bot-1'`);

      const destroyed = await billing.destroyExpiredBots();
      expect(destroyed).toEqual(["bot-1"]);

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("destroyed");
    });

    it("does not destroy bots still within grace period", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.suspendBot("bot-1");

      const destroyed = await billing.destroyExpiredBots();
      expect(destroyed).toEqual([]);

      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("suspended");
    });

    it("does not touch active bots", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");

      const destroyed = await billing.destroyExpiredBots();
      expect(destroyed).toEqual([]);
    });
  });

  describe("getStorageTierCostsForTenant", () => {
    it("returns 0 for a tenant with no active bots", async () => {
      expect(await billing.getStorageTierCostsForTenant("tenant-1")).toBe(0);
    });

    it("returns correct daily cost for known storage tiers", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.setStorageTier("bot-1", "pro");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.setStorageTier("bot-2", "plus");

      expect(await billing.getStorageTierCostsForTenant("tenant-1")).toBe(11);
    });

    it("returns 0 for unknown storage tier (fallback branch)", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      // Bypass setStorageTier to insert an unrecognized tier value directly
      await pool.query(`UPDATE bot_instances SET storage_tier = 'unknown_tier' WHERE id = 'bot-1'`);

      // STORAGE_TIERS['unknown_tier'] is undefined → ?? 0 fallback
      expect(await billing.getStorageTierCostsForTenant("tenant-1")).toBe(0);
    });

    it("does not include suspended bots in storage tier cost", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.setStorageTier("bot-1", "pro");
      await billing.suspendBot("bot-1");

      expect(await billing.getStorageTierCostsForTenant("tenant-1")).toBe(0);
    });
  });

  describe("listForTenant", () => {
    it("lists all bots regardless of billing state", async () => {
      await billing.registerBot("bot-1", "tenant-1", "bot-a");
      await billing.registerBot("bot-2", "tenant-1", "bot-b");
      await billing.registerBot("bot-3", "tenant-2", "bot-c");
      await billing.suspendBot("bot-2");

      const bots = await billing.listForTenant("tenant-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((bots as any[]).length).toBe(2);
    });
  });

  describe("full lifecycle", () => {
    it("active -> suspended -> reactivated -> active", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect(((await billing.getBotBilling("bot-1")) as any)?.billingState).toBe("active");

      await billing.suspendBot("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect(((await billing.getBotBilling("bot-1")) as any)?.billingState).toBe("suspended");

      await billing.reactivateBot("bot-1");
      const info = await billing.getBotBilling("bot-1");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.billingState).toBe("active");
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.suspendedAt).toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect((info as any)?.destroyAfter).toBeNull();
    });

    it("active -> suspended -> destroyed (after grace period)", async () => {
      await billing.registerBot("bot-1", "tenant-1", "my-bot");
      await billing.suspendBot("bot-1");

      await db.update(botInstances).set({ destroyAfter: sql`now() - interval '1 day'` }).where(sql`id = 'bot-1'`);

      await billing.destroyExpiredBots();
      // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
      expect(((await billing.getBotBilling("bot-1")) as any)?.billingState).toBe("destroyed");
    });
  });
});
