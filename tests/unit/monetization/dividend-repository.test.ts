import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "@wopr-network/platform-core/test/db";
import { DrizzleDividendRepository } from "@wopr-network/platform-core/monetization/credits/dividend-repository";
import { Credit } from "@wopr-network/platform-core/credits";

describe("DrizzleDividendRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleDividendRepository;
  let cashAccountId: string;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
    repo = new DrizzleDividendRepository(db);
    // Look up the cash account id (code '1000') seeded by migration
    const rows = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE code = '1000'");
    cashAccountId = rows.rows[0].id;
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
  });

  describe("getStats", () => {
    it("returns zeros when no purchases exist", async () => {
      const stats = await repo.getStats("t-1");
      expect(stats.pool.toCents()).toBe(0);
      expect(Number(stats.activeUsers)).toBe(0);
      expect(stats.perUser.toCents()).toBe(0);
      expect(stats.userEligible).toBe(false);
      expect(stats.userLastPurchaseAt).toBeNull();
      expect(stats.userWindowExpiresAt).toBeNull();
      expect(stats.nextDistributionAt).toBeTypeOf("string");
      expect(new Date(stats.nextDistributionAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("computes pool from yesterday's purchase transactions", async () => {
      // Insert a purchase transaction with yesterday's date
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(12, 0, 0, 0);
      const yesterdayStr = yesterday.toISOString();

      // Insert a journal entry for a purchase by t-other
      await pool.query(
        "INSERT INTO journal_entries (id, posted_at, entry_type, tenant_id, description, reference_id, metadata, created_by) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL)",
        ["je-pool-1", yesterdayStr, "purchase", "t-other"],
      );
      // Insert the credit line on the cash account (credit side of purchase)
      await pool.query(
        "INSERT INTO journal_lines (id, journal_entry_id, account_id, amount, side) VALUES ($1, $2, $3, $4, $5)",
        ["jl-pool-1", "je-pool-1", cashAccountId, Credit.fromCents(1000).toRaw(), "credit"],
      );

      const stats = await repo.getStats("t-1");
      expect(stats.pool.toCents()).toBe(1000);
      expect(Number(stats.activeUsers)).toBe(1); // t-other purchased within 7 days
    });

    it("marks user eligible when they purchased within 7 days", async () => {
      const twoDaysAgo = new Date();
      twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString();

      await pool.query(
        "INSERT INTO journal_entries (id, posted_at, entry_type, tenant_id, description, reference_id, metadata, created_by) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL)",
        ["je-elig-1", twoDaysAgoStr, "purchase", "t-1"],
      );

      const stats = await repo.getStats("t-1");
      expect(stats.userEligible).toBe(true);
      expect(stats.userLastPurchaseAt).toBeTypeOf("string");
      expect(new Date(stats.userLastPurchaseAt!).getTime()).toBeLessThanOrEqual(Date.now());
      expect(stats.userWindowExpiresAt).toBeTypeOf("string");
      expect(new Date(stats.userWindowExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it("marks user ineligible when last purchase is older than 7 days", async () => {
      const tenDaysAgo = new Date();
      tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
      const tenDaysAgoStr = tenDaysAgo.toISOString();

      await pool.query(
        "INSERT INTO journal_entries (id, posted_at, entry_type, tenant_id, description, reference_id, metadata, created_by) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL)",
        ["je-inelig-1", tenDaysAgoStr, "purchase", "t-1"],
      );

      const stats = await repo.getStats("t-1");
      expect(stats.userEligible).toBe(false);
    });

    it("handles division by zero when no active users", async () => {
      // No purchases at all — both pool and active users are 0
      const stats = await repo.getStats("t-1");
      expect(stats.perUser.toCents()).toBe(0);
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

  describe("getLifetimeTotal", () => {
    it("returns 0 when no distributions exist", async () => {
      expect((await repo.getLifetimeTotal("t-1")).toCents()).toBe(0);
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

      expect((await repo.getLifetimeTotal("t-1")).toCents()).toBe(18);
    });
  });
});
