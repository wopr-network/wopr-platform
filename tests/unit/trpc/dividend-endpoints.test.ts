import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "@wopr-network/platform-core/test/db";
import { DrizzleDividendRepository } from "@wopr-network/platform-core/monetization/credits/dividend-repository";
import { appRouter } from "../../../src/trpc/index.js";
import { setBillingRouterDeps } from "../../../src/trpc/routers/billing.js";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc/index";

describe("billing.dividend* tRPC procedures", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let caller: ReturnType<typeof appRouter.createCaller>;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
    const dividendRepo = new DrizzleDividendRepository(db);

    setTrpcOrgMemberRepo({
      findMember: async (orgId: string, userId: string) => {
        if (orgId === "t-1" && userId === "u-1") {
          return { id: "m-1", orgId, userId, role: "owner" as const, joinedAt: Date.now() };
        }
        return null;
      },
      listMembers: async () => [],
      addMember: async () => {},
      updateMemberRole: async () => {},
      removeMember: async () => {},
      countAdminsAndOwners: async () => 1,
      listInvites: async () => [],
      createInvite: async () => {},
      findInviteById: async () => null,
      findInviteByToken: async () => null,
      deleteInvite: async () => {},
      deleteAllMembers: async () => {},
      deleteAllInvites: async () => {},
    });

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

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
  });

  describe("dividendStats", () => {
    it("returns stats with zero pool when no purchases exist", async () => {
      const result = await caller.billing.dividendStats({});
      expect(Number(result.pool_cents)).toBe(0);
      expect(Number(result.active_users)).toBe(0);
      expect(Number(result.per_user_cents)).toBe(0);
      expect(result.user_eligible).toBe(false);
      expect(result.user_last_purchase_at).toBeNull();
      expect(result.user_window_expires_at).toBeNull();
      expect(result.next_distribution_at).toBeTypeOf("string");
    });

    it("returns eligibility when user purchased recently", async () => {
      const recentDate = new Date();
      recentDate.setUTCDate(recentDate.getUTCDate() - 1);
      const dateStr = recentDate.toISOString();

      await pool.query(
        "INSERT INTO journal_entries (id, posted_at, entry_type, tenant_id, description, reference_id, metadata, created_by) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL)",
        ["je-recent-1", dateStr, "purchase", "t-1"],
      );

      const result = await caller.billing.dividendStats({});
      expect(result.user_eligible).toBe(true);
      expect(result.user_last_purchase_at).toBeTypeOf("string");
      expect(result.user_window_expires_at).toBeTypeOf("string");
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
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
        ["d-1", "t-1", "2026-02-19", 8, 6000, 750],
      );
      await pool.query(
        "INSERT INTO dividend_distributions (id, tenant_id, date, amount_cents, pool_cents, active_users) VALUES ($1, $2, $3, $4, $5, $6)",
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
      expect(result.total_cents).toBe(0);
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

      const result = await caller.billing.dividendLifetime({});
      expect(result.total_cents).toBe(18);
    });

    it("rejects cross-tenant access", async () => {
      await expect(caller.billing.dividendLifetime({ tenant: "other-tenant" })).rejects.toThrow("Access denied");
    });
  });
});
