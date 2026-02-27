import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../../src/db/index.js";
import { createTestDb } from "../../../src/test/db.js";
import { DrizzleDividendRepository } from "../../../src/monetization/credits/dividend-repository.js";

describe("DrizzleDividendRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleDividendRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleDividendRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("getStats", () => {
    it("returns zeros when no purchases exist", async () => {
      const stats = await repo.getStats("t-1");
      expect(Number(stats.poolCents)).toBe(0);
      expect(Number(stats.activeUsers)).toBe(0);
      expect(Number(stats.perUserCents)).toBe(0);
      expect(stats.userEligible).toBe(false);
      expect(stats.userLastPurchaseAt).toBeNull();
      expect(stats.userWindowExpiresAt).toBeNull();
      expect(stats.nextDistributionAt).toBeDefined();
    });

    it("computes pool from yesterday's purchase transactions", async () => {
      // Insert a purchase transaction with yesterday's date
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(12, 0, 0, 0);
      const yesterdayStr = yesterday.toISOString();

      await pool.query(
        "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["tx-1", "t-other", 1000, 1000, "purchase", yesterdayStr],
      );

      const stats = await repo.getStats("t-1");
      expect(Number(stats.poolCents)).toBe(1000);
      expect(Number(stats.activeUsers)).toBe(1); // t-other purchased within 7 days
    });

    it("marks user eligible when they purchased within 7 days", async () => {
      const twoDaysAgo = new Date();
      twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString();

      await pool.query(
        "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["tx-1", "t-1", 500, 500, "purchase", twoDaysAgoStr],
      );

      const stats = await repo.getStats("t-1");
      expect(stats.userEligible).toBe(true);
      expect(stats.userLastPurchaseAt).toBeDefined();
      expect(stats.userWindowExpiresAt).toBeDefined();
    });

    it("marks user ineligible when last purchase is older than 7 days", async () => {
      const tenDaysAgo = new Date();
      tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
      const tenDaysAgoStr = tenDaysAgo.toISOString();

      await pool.query(
        "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["tx-1", "t-1", 500, 500, "purchase", tenDaysAgoStr],
      );

      const stats = await repo.getStats("t-1");
      expect(stats.userEligible).toBe(false);
    });

    it("handles division by zero when no active users", async () => {
      // No purchases at all — both pool and active users are 0
      const stats = await repo.getStats("t-1");
      expect(Number(stats.perUserCents)).toBe(0);
    });
  });

  describe("getHistory", () => {
    it("returns empty array when no distributions exist", async () => {
      const history = await repo.getHistory("t-1", 50, 0);
      expect(history).toEqual([]);
    });

    it("returns distributions for the tenant in date-descending order", async () => {
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-1", "t-1", "2026-02-19", 8, 6000, 750],
      );
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-2", "t-1", "2026-02-20", 10, 7000, 700],
      );
      // Different tenant — should not appear
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-3", "t-other", "2026-02-20", 10, 7000, 700],
      );

      const history = await repo.getHistory("t-1", 50, 0);
      expect(history).toHaveLength(2);
      expect(history[0].date).toBe("2026-02-20");
      expect(history[1].date).toBe("2026-02-19");
    });

    it("respects limit and offset", async () => {
      for (let i = 1; i <= 5; i++) {
        await pool.query(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
          [`d-${i}`, "t-1", `2026-02-${String(i).padStart(2, "0")}`, 8, 6000, 750],
        );
      }
      const page = await repo.getHistory("t-1", 2, 2);
      expect(page).toHaveLength(2);
      // Descending order: dates 05,04,03,02,01 — offset 2 gives 03,02
      expect(page[0].date).toBe("2026-02-03");
      expect(page[1].date).toBe("2026-02-02");
    });
  });

  describe("getLifetimeTotalCents", () => {
    it("returns 0 when no distributions exist", async () => {
      expect(await repo.getLifetimeTotalCents("t-1")).toBe(0);
    });

    it("sums all distributions for the tenant", async () => {
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-1", "t-1", "2026-02-19", 8, 6000, 750],
      );
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-2", "t-1", "2026-02-20", 10, 7000, 700],
      );
      // Different tenant — should not be included
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-3", "t-other", "2026-02-20", 99, 7000, 700],
      );

      expect(await repo.getLifetimeTotalCents("t-1")).toBe(18);
    });
  });
});
