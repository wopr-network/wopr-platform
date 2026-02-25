import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../../src/db/index.js";
import { DrizzleDividendRepository } from "../../../src/monetization/credits/dividend-repository.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
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
      attributed_user_id TEXT,
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
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dividend_distributions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      pool_cents INTEGER NOT NULL,
      active_users INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_dividend_dist_tenant ON dividend_distributions(tenant_id)",
  );
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_dividend_dist_date ON dividend_distributions(date)");
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_dividend_dist_tenant_date ON dividend_distributions(tenant_id, date)",
  );
}

describe("DrizzleDividendRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let repo: DrizzleDividendRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    repo = new DrizzleDividendRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("getStats", () => {
    it("returns zeros when no purchases exist", () => {
      const stats = repo.getStats("t-1");
      expect(stats.poolCents).toBe(0);
      expect(stats.activeUsers).toBe(0);
      expect(stats.perUserCents).toBe(0);
      expect(stats.userEligible).toBe(false);
      expect(stats.userLastPurchaseAt).toBeNull();
      expect(stats.userWindowExpiresAt).toBeNull();
      expect(stats.nextDistributionAt).toBeDefined();
    });

    it("computes pool from yesterday's purchase transactions", () => {
      // Insert a purchase transaction with yesterday's date
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(12, 0, 0, 0);
      const yesterdayStr = yesterday.toISOString().replace("T", " ").replace("Z", "").split(".")[0];

      sqlite
        .prepare(
          "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("tx-1", "t-other", 1000, 1000, "purchase", yesterdayStr);

      const stats = repo.getStats("t-1");
      expect(stats.poolCents).toBe(1000);
      expect(stats.activeUsers).toBe(1); // t-other purchased within 7 days
    });

    it("marks user eligible when they purchased within 7 days", () => {
      const twoDaysAgo = new Date();
      twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
      const twoDaysAgoStr = twoDaysAgo
        .toISOString()
        .replace("T", " ")
        .replace("Z", "")
        .split(".")[0];

      sqlite
        .prepare(
          "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("tx-1", "t-1", 500, 500, "purchase", twoDaysAgoStr);

      const stats = repo.getStats("t-1");
      expect(stats.userEligible).toBe(true);
      expect(stats.userLastPurchaseAt).toBeDefined();
      expect(stats.userWindowExpiresAt).toBeDefined();
    });

    it("marks user ineligible when last purchase is older than 7 days", () => {
      const tenDaysAgo = new Date();
      tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
      const tenDaysAgoStr = tenDaysAgo
        .toISOString()
        .replace("T", " ")
        .replace("Z", "")
        .split(".")[0];

      sqlite
        .prepare(
          "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("tx-1", "t-1", 500, 500, "purchase", tenDaysAgoStr);

      const stats = repo.getStats("t-1");
      expect(stats.userEligible).toBe(false);
    });

    it("handles division by zero when no active users", () => {
      // No purchases at all — both pool and active users are 0
      const stats = repo.getStats("t-1");
      expect(stats.perUserCents).toBe(0);
    });
  });

  describe("getHistory", () => {
    it("returns empty array when no distributions exist", () => {
      const history = repo.getHistory("t-1", 50, 0);
      expect(history).toEqual([]);
    });

    it("returns distributions for the tenant in date-descending order", () => {
      sqlite
        .prepare(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("d-1", "t-1", "2026-02-19", 8, 6000, 750);
      sqlite
        .prepare(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("d-2", "t-1", "2026-02-20", 10, 7000, 700);
      // Different tenant — should not appear
      sqlite
        .prepare(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("d-3", "t-other", "2026-02-20", 10, 7000, 700);

      const history = repo.getHistory("t-1", 50, 0);
      expect(history).toHaveLength(2);
      expect(history[0].date).toBe("2026-02-20");
      expect(history[1].date).toBe("2026-02-19");
    });

    it("respects limit and offset", () => {
      for (let i = 1; i <= 5; i++) {
        sqlite
          .prepare(
            "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(`d-${i}`, "t-1", `2026-02-${String(i).padStart(2, "0")}`, 8, 6000, 750);
      }
      const page = repo.getHistory("t-1", 2, 2);
      expect(page).toHaveLength(2);
      // Descending order: dates 05,04,03,02,01 — offset 2 gives 03,02
      expect(page[0].date).toBe("2026-02-03");
      expect(page[1].date).toBe("2026-02-02");
    });
  });

  describe("getLifetimeTotalCents", () => {
    it("returns 0 when no distributions exist", () => {
      expect(repo.getLifetimeTotalCents("t-1")).toBe(0);
    });

    it("sums all distributions for the tenant", () => {
      sqlite
        .prepare(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("d-1", "t-1", "2026-02-19", 8, 6000, 750);
      sqlite
        .prepare(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("d-2", "t-1", "2026-02-20", 10, 7000, 700);
      // Different tenant — should not be included
      sqlite
        .prepare(
          "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("d-3", "t-other", "2026-02-20", 99, 7000, 700);

      expect(repo.getLifetimeTotalCents("t-1")).toBe(18);
    });
  });
});
