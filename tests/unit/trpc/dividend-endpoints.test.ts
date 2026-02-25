import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../../src/db/index.js";
import { DrizzleDividendRepository } from "../../../src/monetization/credits/dividend-repository.js";
import { appRouter } from "../../../src/trpc/index.js";
import { setBillingRouterDeps } from "../../../src/trpc/routers/billing.js";

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
}

describe("billing.dividend* tRPC procedures", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let caller: ReturnType<typeof appRouter.createCaller>;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    const dividendRepo = new DrizzleDividendRepository(db);

    setBillingRouterDeps({
      stripe: {
        checkout: { sessions: { create: vi.fn() } },
        billingPortal: { sessions: { create: vi.fn() } },
      } as never,
      tenantStore: {} as never,
      creditStore: {
        getBalance: vi.fn().mockReturnValue(0),
        listTransactions: vi.fn().mockReturnValue([]),
      } as never,
      meterAggregator: {
        getTenantTotal: vi.fn().mockReturnValue({ totalCharge: 0, totalCost: 0, eventCount: 0 }),
        querySummaries: vi.fn().mockReturnValue([]),
      } as never,
      usageReporter: { queryReports: vi.fn().mockReturnValue([]) } as never,
      priceMap: undefined,
      dividendRepo,
    });

    caller = appRouter.createCaller({ user: { id: "u-1", roles: ["admin"] }, tenantId: "t-1" });
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("dividendStats", () => {
    it("returns stats with zero pool when no purchases exist", async () => {
      const result = await caller.billing.dividendStats({});
      expect(result.pool_cents).toBe(0);
      expect(result.active_users).toBe(0);
      expect(result.per_user_cents).toBe(0);
      expect(result.user_eligible).toBe(false);
      expect(result.user_last_purchase_at).toBeNull();
      expect(result.user_window_expires_at).toBeNull();
      expect(result.next_distribution_at).toBeDefined();
    });

    it("returns eligibility when user purchased recently", async () => {
      const recentDate = new Date();
      recentDate.setUTCDate(recentDate.getUTCDate() - 1);
      const dateStr = recentDate.toISOString().replace("T", " ").replace("Z", "").split(".")[0];

      sqlite
        .prepare(
          "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("tx-1", "t-1", 500, 500, "purchase", dateStr);

      const result = await caller.billing.dividendStats({});
      expect(result.user_eligible).toBe(true);
      expect(result.user_last_purchase_at).toBeDefined();
      expect(result.user_window_expires_at).toBeDefined();
    });

    it("rejects cross-tenant access", async () => {
      await expect(caller.billing.dividendStats({ tenant: "other-tenant" })).rejects.toThrow("Access denied");
    });
  });

  describe("dividendHistory", () => {
    it("returns empty array when no distributions exist", async () => {
      const result = await caller.billing.dividendHistory({});
      expect(result.dividends).toEqual([]);
    });

    it("returns distributions for the tenant", async () => {
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

      const result = await caller.billing.dividendHistory({});
      expect(result.dividends).toHaveLength(2);
      expect(result.dividends[0].date).toBe("2026-02-20");
    });

    it("rejects cross-tenant access", async () => {
      await expect(caller.billing.dividendHistory({ tenant: "other-tenant" })).rejects.toThrow("Access denied");
    });
  });

  describe("dividendLifetime", () => {
    it("returns 0 when no distributions exist", async () => {
      const result = await caller.billing.dividendLifetime({});
      expect(result.total_cents).toBe(0);
    });

    it("sums all distributions for the tenant", async () => {
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

      const result = await caller.billing.dividendLifetime({});
      expect(result.total_cents).toBe(18);
    });

    it("rejects cross-tenant access", async () => {
      await expect(caller.billing.dividendLifetime({ tenant: "other-tenant" })).rejects.toThrow("Access denied");
    });
  });
});
