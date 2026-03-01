import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import { dividendDistributions } from "../../db/schema/dividend-distributions.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "./credit-ledger.js";
import { DrizzleDividendRepository } from "./dividend-repository.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

/** Insert a dividend_distributions row directly (bypassing repo — it has no write method). */
async function seedDividend(opts: {
  tenantId: string;
  date: string;
  amountCents: number;
  poolCents: number;
  activeUsers: number;
}): Promise<void> {
  await db.insert(dividendDistributions).values({
    id: crypto.randomUUID(),
    tenantId: opts.tenantId,
    date: opts.date,
    amountCents: opts.amountCents,
    poolCents: opts.poolCents,
    activeUsers: opts.activeUsers,
  });
}

/** Insert an admin_users row for getTenantEmail tests. */
async function seedAdminUser(tenantId: string, email: string): Promise<void> {
  await db.insert(adminUsers).values({
    id: crypto.randomUUID(),
    email,
    tenantId,
    status: "active",
    role: "tenant_admin",
    createdAt: Date.now(),
  });
}

describe("DrizzleDividendRepository", () => {
  let repo: DrizzleDividendRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleDividendRepository(db);
  });

  // --- getHistory() ---

  describe("getHistory()", () => {
    it("returns empty array when tenant has no distributions", async () => {
      const history = await repo.getHistory("nonexistent", 50, 0);
      expect(history).toEqual([]);
    });

    it("returns distributions in reverse chronological order", async () => {
      await seedDividend({ tenantId: "t1", date: "2026-01-01", amountCents: 10, poolCents: 1000, activeUsers: 5 });
      await seedDividend({ tenantId: "t1", date: "2026-01-02", amountCents: 20, poolCents: 2000, activeUsers: 10 });
      await seedDividend({ tenantId: "t1", date: "2026-01-03", amountCents: 30, poolCents: 3000, activeUsers: 15 });

      const history = await repo.getHistory("t1", 50, 0);
      expect(history).toHaveLength(3);
      expect(history[0].date).toBe("2026-01-03");
      expect(history[1].date).toBe("2026-01-02");
      expect(history[2].date).toBe("2026-01-01");
    });

    it("converts amountCents and poolCents to Credit objects", async () => {
      await seedDividend({ tenantId: "t1", date: "2026-01-15", amountCents: 42, poolCents: 5000, activeUsers: 8 });

      const history = await repo.getHistory("t1", 50, 0);
      expect(history).toHaveLength(1);
      expect(history[0].amount.toCents()).toBe(42);
      expect(history[0].pool.toCents()).toBe(5000);
      expect(history[0].activeUsers).toBe(8);
    });

    it("respects limit and offset", async () => {
      for (let i = 1; i <= 5; i++) {
        await seedDividend({
          tenantId: "t1",
          date: `2026-01-0${i}`,
          amountCents: i * 10,
          poolCents: 1000,
          activeUsers: 5,
        });
      }

      const page1 = await repo.getHistory("t1", 2, 0);
      expect(page1).toHaveLength(2);
      expect(page1[0].date).toBe("2026-01-05");
      expect(page1[1].date).toBe("2026-01-04");

      const page2 = await repo.getHistory("t1", 2, 2);
      expect(page2).toHaveLength(2);
      expect(page2[0].date).toBe("2026-01-03");
    });

    it("is tenant-isolated", async () => {
      await seedDividend({ tenantId: "t1", date: "2026-01-01", amountCents: 10, poolCents: 1000, activeUsers: 5 });
      await seedDividend({ tenantId: "t2", date: "2026-01-01", amountCents: 99, poolCents: 9000, activeUsers: 50 });

      const t1History = await repo.getHistory("t1", 50, 0);
      expect(t1History).toHaveLength(1);
      expect(t1History[0].amount.toCents()).toBe(10);
    });
  });

  // --- getLifetimeTotal() ---

  describe("getLifetimeTotal()", () => {
    it("returns Credit.ZERO when tenant has no distributions", async () => {
      const total = await repo.getLifetimeTotal("nonexistent");
      expect(total.toCents()).toBe(0);
    });

    it("sums all distributions for a tenant", async () => {
      await seedDividend({ tenantId: "t1", date: "2026-01-01", amountCents: 10, poolCents: 1000, activeUsers: 5 });
      await seedDividend({ tenantId: "t1", date: "2026-01-02", amountCents: 25, poolCents: 2000, activeUsers: 10 });

      const total = await repo.getLifetimeTotal("t1");
      expect(total.toCents()).toBe(35);
    });

    it("is tenant-isolated", async () => {
      await seedDividend({ tenantId: "t1", date: "2026-01-01", amountCents: 10, poolCents: 1000, activeUsers: 5 });
      await seedDividend({ tenantId: "t2", date: "2026-01-01", amountCents: 999, poolCents: 9000, activeUsers: 50 });

      const total = await repo.getLifetimeTotal("t1");
      expect(total.toCents()).toBe(10);
    });
  });

  // --- getDigestTenantAggregates() ---

  describe("getDigestTenantAggregates()", () => {
    it("returns empty array when no distributions in window", async () => {
      const result = await repo.getDigestTenantAggregates("2026-02-01", "2026-02-28");
      expect(result).toEqual([]);
    });

    it("aggregates distributions per tenant within [windowStart, windowEnd)", async () => {
      // In window
      await seedDividend({ tenantId: "t1", date: "2026-02-01", amountCents: 10, poolCents: 1000, activeUsers: 5 });
      await seedDividend({ tenantId: "t1", date: "2026-02-02", amountCents: 20, poolCents: 2000, activeUsers: 10 });
      // Out of window
      await seedDividend({ tenantId: "t1", date: "2026-03-01", amountCents: 999, poolCents: 9000, activeUsers: 50 });

      const result = await repo.getDigestTenantAggregates("2026-02-01", "2026-03-01");
      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe("t1");
      expect(result[0].total.toCents()).toBe(30); // 10 + 20
      expect(result[0].distributionCount).toBe(2);
    });

    it("returns multiple tenants", async () => {
      await seedDividend({ tenantId: "t1", date: "2026-02-01", amountCents: 10, poolCents: 1000, activeUsers: 5 });
      await seedDividend({ tenantId: "t2", date: "2026-02-01", amountCents: 50, poolCents: 5000, activeUsers: 20 });

      const result = await repo.getDigestTenantAggregates("2026-02-01", "2026-03-01");
      expect(result).toHaveLength(2);

      const t1 = result.find((r) => r.tenantId === "t1");
      const t2 = result.find((r) => r.tenantId === "t2");
      expect(t1?.total.toCents()).toBe(10);
      expect(t2?.total.toCents()).toBe(50);
    });
  });

  // --- getStats() ---

  describe("getStats()", () => {
    it("returns zero pool and zero activeUsers when no purchase transactions exist", async () => {
      const stats = await repo.getStats("t1");
      expect(stats.pool.toCents()).toBe(0);
      expect(stats.activeUsers).toBe(0);
      expect(stats.perUser.toCents()).toBe(0);
      expect(stats.userEligible).toBe(false);
      expect(stats.userLastPurchaseAt).toBeNull();
      expect(stats.userWindowExpiresAt).toBeNull();
      expect(stats.nextDistributionAt).toBeDefined();
    });

    it("marks user as eligible when they have a recent purchase", async () => {
      const ledger = new CreditLedger(db);
      await ledger.credit("t1", Credit.fromCents(100), "purchase", "recent buy");

      const stats = await repo.getStats("t1");
      expect(stats.userEligible).toBe(true);
      expect(stats.userLastPurchaseAt).toBeDefined();
      expect(stats.userWindowExpiresAt).toBeDefined();
    });
  });

  // --- getTenantEmail() ---

  describe("getTenantEmail()", () => {
    it("returns undefined when tenant has no admin user", async () => {
      const email = await repo.getTenantEmail("nonexistent");
      expect(email).toBeUndefined();
    });

    it("returns the email for the tenant's admin user", async () => {
      await seedAdminUser("t1", "alice@example.com");

      const email = await repo.getTenantEmail("t1");
      expect(email).toBe("alice@example.com");
    });
  });
});
