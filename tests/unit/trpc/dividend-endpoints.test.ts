import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../../src/db/index.js";
import { createTestDb } from "../../../src/test/db.js";
import { DrizzleDividendRepository } from "../../../src/monetization/credits/dividend-repository.js";
import { appRouter } from "../../../src/trpc/index.js";
import { setBillingRouterDeps } from "../../../src/trpc/routers/billing.js";

describe("billing.dividend* tRPC procedures", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let caller: ReturnType<typeof appRouter.createCaller>;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    const dividendRepo = new DrizzleDividendRepository(db);

    setBillingRouterDeps({
      stripe: {
        checkout: { sessions: { create: vi.fn() } },
        billingPortal: { sessions: { create: vi.fn() } },
      } as never,
      tenantStore: {} as never,
      creditLedger: {
        balance: vi.fn().mockResolvedValue(0),
        history: vi.fn().mockResolvedValue([]),
        credit: vi.fn(),
        debit: vi.fn(),
        hasReferenceId: vi.fn(),
        tenantsWithBalance: vi.fn(),
      } as never,
      meterAggregator: {
        getTenantTotal: vi.fn().mockResolvedValue({ totalCharge: 0, totalCost: 0, eventCount: 0 }),
        querySummaries: vi.fn().mockResolvedValue([]),
      } as never,
      priceMap: undefined,
      dividendRepo,
      autoTopupSettingsStore: {} as never,
      spendingLimitsRepo: {} as never,
      affiliateRepo: {} as never,
    });

    caller = appRouter.createCaller({ user: { id: "u-1", roles: ["admin"] }, tenantId: "t-1" });
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("dividendStats", () => {
    it("returns stats with zero pool when no purchases exist", async () => {
      const result = await caller.billing.dividendStats({});
      expect(result.pool_credits).toBe(0);
      expect(result.active_users).toBe(0);
      expect(result.per_user_credits).toBe(0);
      expect(result.user_eligible).toBe(false);
      expect(result.user_last_purchase_at).toBeNull();
      expect(result.user_window_expires_at).toBeNull();
      expect(result.next_distribution_at).toBeDefined();
    });

    it("returns eligibility when user purchased recently", async () => {
      const recentDate = new Date();
      recentDate.setUTCDate(recentDate.getUTCDate() - 1);
      const dateStr = recentDate.toISOString();

      await pool.query(
        "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["tx-1", "t-1", 500, 500, "purchase", dateStr],
      );

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
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_credits, pool_credits, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-1", "t-1", "2026-02-19", 8, 6000, 750],
      );
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_credits, pool_credits, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-2", "t-1", "2026-02-20", 10, 7000, 700],
      );

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
      expect(result.total_credits).toBe(0);
    });

    it("sums all distributions for the tenant", async () => {
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_credits, pool_credits, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-1", "t-1", "2026-02-19", 8, 6000, 750],
      );
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_credits, pool_credits, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-2", "t-1", "2026-02-20", 10, 7000, 700],
      );

      const result = await caller.billing.dividendLifetime({});
      expect(result.total_credits).toBe(18);
    });

    it("rejects cross-tenant access", async () => {
      await expect(caller.billing.dividendLifetime({ tenant: "other-tenant" })).rejects.toThrow("Access denied");
    });
  });
});
