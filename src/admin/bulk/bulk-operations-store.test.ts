import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAdminAuditLogRepository } from "../../admin/admin-audit-log-repository.js";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { AdminAuditLog } from "../audit-log.js";
import { TenantStatusStore } from "../tenant-status/tenant-status-store.js";
import { DrizzleBulkOperationsRepository } from "./bulk-operations-repository.js";
import { BulkOperationsStore, MAX_BULK_SIZE, UNDO_WINDOW_MS } from "./bulk-operations-store.js";

describe("BulkOperationsStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let creditStore: ICreditLedger;
  let tenantStatusStore: TenantStatusStore;
  let auditLog: AdminAuditLog;
  let store: BulkOperationsStore;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);

    const balances = new Map<string, number>();
    creditStore = {
      async credit(tenantId, amountCredits) {
        balances.set(tenantId, (balances.get(tenantId) ?? 0) + amountCredits);
        return {
          id: "tx-1",
          tenantId,
          amountCredits,
          balanceAfterCredits: balances.get(tenantId) ?? 0,
          type: "signup_grant" as const,
          description: null,
          referenceId: null,
          fundingSource: null,
          attributedUserId: null,
          createdAt: new Date().toISOString(),
        };
      },
      async debit(tenantId, amountCredits) {
        balances.set(tenantId, (balances.get(tenantId) ?? 0) - amountCredits);
        return {
          id: "tx-2",
          tenantId,
          amountCredits: -amountCredits,
          balanceAfterCredits: balances.get(tenantId) ?? 0,
          type: "correction" as const,
          description: null,
          referenceId: null,
          fundingSource: null,
          attributedUserId: null,
          createdAt: new Date().toISOString(),
        };
      },
      async balance(tenantId) {
        return balances.get(tenantId) ?? 0;
      },
      async hasReferenceId() {
        return false;
      },
      async history() {
        return [];
      },
      async tenantsWithBalance() {
        return [];
      },
      async memberUsage(_tenantId: string) {
        return [];
      },
    };

    tenantStatusStore = new TenantStatusStore(db);
    auditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db));
    const bulkRepo = new DrizzleBulkOperationsRepository(db);
    store = new BulkOperationsStore(bulkRepo, creditStore, tenantStatusStore, auditLog);

    const now = Date.now();
    await db.insert(adminUsers).values([
      {
        id: "u1",
        email: "alice@test.com",
        name: "Alice",
        tenantId: "tenant-1",
        status: "active",
        role: "user",
        creditBalanceCredits: 1000,
        agentCount: 2,
        createdAt: now,
      },
      {
        id: "u2",
        email: "bob@test.com",
        name: "Bob",
        tenantId: "tenant-2",
        status: "active",
        role: "user",
        creditBalanceCredits: 500,
        agentCount: 1,
        createdAt: now,
      },
      {
        id: "u3",
        email: "carol@test.com",
        name: "Carol",
        tenantId: "tenant-3",
        status: "suspended",
        role: "user",
        creditBalanceCredits: 0,
        agentCount: 0,
        createdAt: now,
      },
      {
        id: "u4",
        email: "dave@test.com",
        name: "Dave",
        tenantId: "tenant-4",
        status: "active",
        role: "tenant_admin",
        creditBalanceCredits: 200,
        agentCount: 3,
        createdAt: now,
      },
      {
        id: "u5",
        email: "eve@test.com",
        name: "Eve",
        tenantId: "tenant-5",
        status: "dormant",
        role: "user",
        creditBalanceCredits: 0,
        agentCount: 0,
        createdAt: now,
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe("validation", () => {
    it("rejects empty tenant IDs array", async () => {
      await expect(() =>
        store.bulkGrant({ tenantIds: [], amountCredits: 100, reason: "test", notifyByEmail: false }, "admin"),
      ).rejects.toThrow("At least one tenant must be selected");
    });

    it("rejects >500 tenant IDs", async () => {
      const ids = Array.from({ length: 501 }, (_, i) => `tenant-${i}`);
      await expect(() =>
        store.bulkGrant({ tenantIds: ids, amountCredits: 100, reason: "test", notifyByEmail: false }, "admin"),
      ).rejects.toThrow(`Maximum ${MAX_BULK_SIZE} tenants per bulk operation`);
    });
  });

  // ---------------------------------------------------------------------------
  // bulkGrant
  // ---------------------------------------------------------------------------

  describe("bulkGrant", () => {
    it("grants credits to multiple tenants and returns correct counts", async () => {
      const result = await store.bulkGrant(
        { tenantIds: ["tenant-1", "tenant-2"], amountCredits: 500, reason: "Outage comp", notifyByEmail: false },
        "admin-1",
      );
      expect(result.action).toBe("grant");
      expect(result.requested).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.totalAmountCents).toBe(1000);
      expect(result.undoDeadline).toBeGreaterThan(Date.now());

      expect(await creditStore.balance("tenant-1")).toBe(500);
      expect(await creditStore.balance("tenant-2")).toBe(500);
    });

    it("creates an audit log entry with category bulk", async () => {
      await store.bulkGrant(
        { tenantIds: ["tenant-1"], amountCredits: 100, reason: "test", notifyByEmail: true },
        "admin-1",
      );
      const logs = await auditLog.query({ action: "bulk.grant" });
      expect(logs.entries).toHaveLength(1);
      expect(logs.entries[0].category).toBe("bulk");
      const details = JSON.parse(logs.entries[0].details);
      expect(details.tenantIds).toContain("tenant-1");
      expect(details.notifyByEmail).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // undoGrant
  // ---------------------------------------------------------------------------

  describe("undoGrant", () => {
    it("reverses a grant within the 5-minute window", async () => {
      const grant = await store.bulkGrant(
        { tenantIds: ["tenant-1", "tenant-2"], amountCredits: 300, reason: "test", notifyByEmail: false },
        "admin-1",
      );
      expect(await creditStore.balance("tenant-1")).toBe(300);

      const undo = await store.undoGrant(grant.operationId, "admin-1");
      expect(undo.succeeded).toBe(2);
      expect(undo.failed).toBe(0);
      expect(await creditStore.balance("tenant-1")).toBe(0);
      expect(await creditStore.balance("tenant-2")).toBe(0);
    });

    it("fails after 5-minute window expires", async () => {
      vi.useFakeTimers();
      const grant = await store.bulkGrant(
        { tenantIds: ["tenant-1"], amountCredits: 100, reason: "test", notifyByEmail: false },
        "admin-1",
      );
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 1000);
      await expect(() => store.undoGrant(grant.operationId, "admin-1")).rejects.toThrow("Undo window has expired");
    });

    it("fails if already undone", async () => {
      const grant = await store.bulkGrant(
        { tenantIds: ["tenant-1"], amountCredits: 100, reason: "test", notifyByEmail: false },
        "admin-1",
      );
      await store.undoGrant(grant.operationId, "admin-1");
      await expect(() => store.undoGrant(grant.operationId, "admin-1")).rejects.toThrow("already been undone");
    });

    it("fails for non-existent operation ID", async () => {
      await expect(() => store.undoGrant("00000000-0000-0000-0000-000000000000", "admin-1")).rejects.toThrow(
        "not found",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // bulkSuspend
  // ---------------------------------------------------------------------------

  describe("bulkSuspend", () => {
    it("suspends multiple active tenants", async () => {
      await tenantStatusStore.ensureExists("tenant-1");
      await tenantStatusStore.ensureExists("tenant-2");

      const result = await store.bulkSuspend(
        { tenantIds: ["tenant-1", "tenant-2"], reason: "Dormant cleanup", notifyByEmail: false },
        "admin-1",
      );
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(await tenantStatusStore.getStatus("tenant-1")).toBe("suspended");
      expect(await tenantStatusStore.getStatus("tenant-2")).toBe("suspended");
    });

    it("skips already-suspended tenants", async () => {
      await tenantStatusStore.ensureExists("tenant-1");
      await tenantStatusStore.suspend("tenant-1", "prior", "admin-0");

      const result = await store.bulkSuspend(
        { tenantIds: ["tenant-1"], reason: "test", notifyByEmail: false },
        "admin-1",
      );
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("Already suspended");
    });

    it("skips banned tenants", async () => {
      await tenantStatusStore.ensureExists("tenant-1");
      await tenantStatusStore.ban("tenant-1", "tos violation", "admin-0");

      const result = await store.bulkSuspend(
        { tenantIds: ["tenant-1"], reason: "test", notifyByEmail: false },
        "admin-1",
      );
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("banned");
    });

    it("tracks partial failures correctly", async () => {
      await tenantStatusStore.ensureExists("tenant-1");
      await tenantStatusStore.ensureExists("tenant-2");
      await tenantStatusStore.suspend("tenant-2", "prior", "admin-0");

      const result = await store.bulkSuspend(
        { tenantIds: ["tenant-1", "tenant-2"], reason: "test", notifyByEmail: false },
        "admin-1",
      );
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // bulkReactivate
  // ---------------------------------------------------------------------------

  describe("bulkReactivate", () => {
    it("reactivates multiple suspended tenants", async () => {
      await tenantStatusStore.ensureExists("tenant-1");
      await tenantStatusStore.ensureExists("tenant-2");
      await tenantStatusStore.suspend("tenant-1", "prior", "admin-0");
      await tenantStatusStore.suspend("tenant-2", "prior", "admin-0");

      const result = await store.bulkReactivate({ tenantIds: ["tenant-1", "tenant-2"] }, "admin-1");
      expect(result.succeeded).toBe(2);
      expect(await tenantStatusStore.getStatus("tenant-1")).toBe("active");
      expect(await tenantStatusStore.getStatus("tenant-2")).toBe("active");
    });

    it("skips already-active tenants", async () => {
      await tenantStatusStore.ensureExists("tenant-1");

      const result = await store.bulkReactivate({ tenantIds: ["tenant-1"] }, "admin-1");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("Already active");
    });

    it("skips banned tenants", async () => {
      await tenantStatusStore.ensureExists("tenant-1");
      await tenantStatusStore.ban("tenant-1", "tos violation", "admin-0");

      const result = await store.bulkReactivate({ tenantIds: ["tenant-1"] }, "admin-1");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("banned");
    });
  });

  // ---------------------------------------------------------------------------
  // bulkExport
  // ---------------------------------------------------------------------------

  describe("bulkExport", () => {
    it("generates CSV with selected fields", async () => {
      const result = await store.bulkExport(
        {
          tenantIds: ["tenant-1", "tenant-2"],
          fields: [
            { key: "account_info", enabled: true },
            { key: "credit_balance", enabled: true },
            { key: "monthly_products", enabled: false },
            { key: "lifetime_spend", enabled: false },
            { key: "last_seen", enabled: false },
            { key: "transaction_history", enabled: false },
          ],
        },
        "admin-1",
      );
      expect(result.rowCount).toBe(2);
      const lines = result.csv.split("\n");
      expect(lines[0]).toBe("tenant_id,name,email,status,role,credit_balance_credits");
      expect(lines.length).toBe(3); // header + 2 data rows
    });

    it("generates CSV with all fields enabled", async () => {
      const result = await store.bulkExport(
        {
          tenantIds: ["tenant-1"],
          fields: [
            { key: "account_info", enabled: true },
            { key: "credit_balance", enabled: true },
            { key: "monthly_products", enabled: true },
            { key: "lifetime_spend", enabled: true },
            { key: "last_seen", enabled: true },
            { key: "transaction_history", enabled: false },
          ],
        },
        "admin-1",
      );
      expect(result.csv).toContain(
        "tenant_id,name,email,status,role,credit_balance_credits,agent_count,lifetime_spend_cents,last_seen",
      );
    });

    it("handles empty result for valid tenant IDs with no matching rows", async () => {
      const result = await store.bulkExport(
        {
          tenantIds: ["nonexistent-tenant"],
          fields: [{ key: "account_info", enabled: true }],
        },
        "admin-1",
      );
      expect(result.rowCount).toBe(0);
      const lines = result.csv.split("\n");
      expect(lines.length).toBe(1); // header only
    });
  });

  // ---------------------------------------------------------------------------
  // dryRun
  // ---------------------------------------------------------------------------

  describe("dryRun", () => {
    it("returns correct tenant info for preview", async () => {
      const tenants = await store.dryRun(["tenant-1", "tenant-2"]);
      expect(tenants).toHaveLength(2);
      expect(tenants[0].tenantId).toBe("tenant-1");
      expect(tenants[0].email).toBe("alice@test.com");
      expect(tenants[0].status).toBe("active");
    });
  });

  // ---------------------------------------------------------------------------
  // listMatchingTenantIds
  // ---------------------------------------------------------------------------

  describe("listMatchingTenantIds", () => {
    it("returns filtered IDs matching status filter", async () => {
      const ids = await store.listMatchingTenantIds({ status: "active" });
      expect(ids).toContain("tenant-1");
      expect(ids).toContain("tenant-2");
      expect(ids).toContain("tenant-4");
      expect(ids).not.toContain("tenant-3"); // suspended
    });

    it("returns filtered IDs matching search filter", async () => {
      const ids = await store.listMatchingTenantIds({ search: "alice" });
      expect(ids).toEqual(["tenant-1"]);
    });

    it("returns all IDs with no filters", async () => {
      const ids = await store.listMatchingTenantIds({});
      expect(ids).toHaveLength(5);
    });
  });
});
