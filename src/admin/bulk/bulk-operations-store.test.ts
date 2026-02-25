import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAdminAuditLogRepository } from "../../admin/admin-audit-log-repository.js";
import type { DrizzleDb } from "../../db/index.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import { createTestDb } from "../../test/db.js";
import { AdminAuditLog } from "../audit-log.js";
import { TenantStatusStore } from "../tenant-status/tenant-status-store.js";
import { DrizzleBulkOperationsRepository } from "./bulk-operations-repository.js";
import { BulkOperationsStore, MAX_BULK_SIZE, UNDO_WINDOW_MS } from "./bulk-operations-store.js";

describe("BulkOperationsStore", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let creditStore: ICreditLedger;
  let tenantStatusStore: TenantStatusStore;
  let auditLog: AdminAuditLog;
  let store: BulkOperationsStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;

    const balances = new Map<string, number>();
    creditStore = {
      credit(tenantId, amountCents) {
        const balanceAfterCents = (balances.get(tenantId) ?? 0) + amountCents;
        balances.set(tenantId, balanceAfterCents);
        return {
          id: "tx-1",
          tenantId,
          amountCents,
          balanceAfterCents,
          type: "signup_grant",
          description: null,
          referenceId: null,
          fundingSource: null,
          createdAt: new Date().toISOString(),
        };
      },
      debit(tenantId, amountCents) {
        const balanceAfterCents = (balances.get(tenantId) ?? 0) - amountCents;
        balances.set(tenantId, balanceAfterCents);
        return {
          id: "tx-2",
          tenantId,
          amountCents: -amountCents,
          balanceAfterCents,
          type: "correction",
          description: null,
          referenceId: null,
          fundingSource: null,
          createdAt: new Date().toISOString(),
        };
      },
      balance(tenantId) {
        return balances.get(tenantId) ?? 0;
      },
      hasReferenceId() {
        return false;
      },
      history() {
        return [];
      },
      tenantsWithBalance() {
        return [];
      },
    };
    tenantStatusStore = new TenantStatusStore(db);
    auditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db));
    const bulkRepo = new DrizzleBulkOperationsRepository(db, sqlite);
    store = new BulkOperationsStore(bulkRepo, creditStore, tenantStatusStore, auditLog);

    // Seed test data using raw sqlite (admin_users table created by Drizzle migration)
    const insertUser = sqlite.prepare(
      `INSERT INTO admin_users (id, email, name, tenant_id, status, role, credit_balance_cents, agent_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insertUser.run("u1", "alice@test.com", "Alice", "tenant-1", "active", "user", 1000, 2, now);
    insertUser.run("u2", "bob@test.com", "Bob", "tenant-2", "active", "user", 500, 1, now);
    insertUser.run("u3", "carol@test.com", "Carol", "tenant-3", "suspended", "user", 0, 0, now);
    insertUser.run("u4", "dave@test.com", "Dave", "tenant-4", "active", "tenant_admin", 200, 3, now);
    insertUser.run("u5", "eve@test.com", "Eve", "tenant-5", "dormant", "user", 0, 0, now);
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe("validation", () => {
    it("rejects empty tenant IDs array", () => {
      expect(() =>
        store.bulkGrant({ tenantIds: [], amountCents: 100, reason: "test", notifyByEmail: false }, "admin"),
      ).toThrow("At least one tenant must be selected");
    });

    it("rejects >500 tenant IDs", () => {
      const ids = Array.from({ length: 501 }, (_, i) => `tenant-${i}`);
      expect(() =>
        store.bulkGrant({ tenantIds: ids, amountCents: 100, reason: "test", notifyByEmail: false }, "admin"),
      ).toThrow(`Maximum ${MAX_BULK_SIZE} tenants per bulk operation`);
    });
  });

  // ---------------------------------------------------------------------------
  // bulkGrant
  // ---------------------------------------------------------------------------

  describe("bulkGrant", () => {
    it("grants credits to multiple tenants and returns correct counts", () => {
      const result = store.bulkGrant(
        { tenantIds: ["tenant-1", "tenant-2"], amountCents: 500, reason: "Outage comp", notifyByEmail: false },
        "admin-1",
      );
      expect(result.action).toBe("grant");
      expect(result.requested).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.totalAmountCents).toBe(1000);
      expect(result.undoDeadline).toBeGreaterThan(Date.now());

      expect(creditStore.balance("tenant-1")).toBe(500);
      expect(creditStore.balance("tenant-2")).toBe(500);
    });

    it("creates an audit log entry with category bulk", () => {
      store.bulkGrant({ tenantIds: ["tenant-1"], amountCents: 100, reason: "test", notifyByEmail: true }, "admin-1");
      const logs = auditLog.query({ action: "bulk.grant" });
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
    it("reverses a grant within the 5-minute window", () => {
      const grant = store.bulkGrant(
        { tenantIds: ["tenant-1", "tenant-2"], amountCents: 300, reason: "test", notifyByEmail: false },
        "admin-1",
      );
      expect(creditStore.balance("tenant-1")).toBe(300);

      const undo = store.undoGrant(grant.operationId, "admin-1");
      expect(undo.succeeded).toBe(2);
      expect(undo.failed).toBe(0);
      expect(creditStore.balance("tenant-1")).toBe(0);
      expect(creditStore.balance("tenant-2")).toBe(0);
    });

    it("fails after 5-minute window expires", () => {
      vi.useFakeTimers();
      const grant = store.bulkGrant(
        { tenantIds: ["tenant-1"], amountCents: 100, reason: "test", notifyByEmail: false },
        "admin-1",
      );
      vi.advanceTimersByTime(UNDO_WINDOW_MS + 1000);
      expect(() => store.undoGrant(grant.operationId, "admin-1")).toThrow("Undo window has expired");
    });

    it("fails if already undone", () => {
      const grant = store.bulkGrant(
        { tenantIds: ["tenant-1"], amountCents: 100, reason: "test", notifyByEmail: false },
        "admin-1",
      );
      store.undoGrant(grant.operationId, "admin-1");
      expect(() => store.undoGrant(grant.operationId, "admin-1")).toThrow("already been undone");
    });

    it("fails for non-existent operation ID", () => {
      expect(() => store.undoGrant("00000000-0000-0000-0000-000000000000", "admin-1")).toThrow("not found");
    });
  });

  // ---------------------------------------------------------------------------
  // bulkSuspend
  // ---------------------------------------------------------------------------

  describe("bulkSuspend", () => {
    it("suspends multiple active tenants", () => {
      // Ensure tenants have status rows
      tenantStatusStore.ensureExists("tenant-1");
      tenantStatusStore.ensureExists("tenant-2");

      const result = store.bulkSuspend(
        { tenantIds: ["tenant-1", "tenant-2"], reason: "Dormant cleanup", notifyByEmail: false },
        "admin-1",
      );
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(tenantStatusStore.getStatus("tenant-1")).toBe("suspended");
      expect(tenantStatusStore.getStatus("tenant-2")).toBe("suspended");
    });

    it("skips already-suspended tenants", () => {
      tenantStatusStore.ensureExists("tenant-1");
      tenantStatusStore.suspend("tenant-1", "prior", "admin-0");

      const result = store.bulkSuspend({ tenantIds: ["tenant-1"], reason: "test", notifyByEmail: false }, "admin-1");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("Already suspended");
    });

    it("skips banned tenants", () => {
      tenantStatusStore.ensureExists("tenant-1");
      tenantStatusStore.ban("tenant-1", "tos violation", "admin-0");

      const result = store.bulkSuspend({ tenantIds: ["tenant-1"], reason: "test", notifyByEmail: false }, "admin-1");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("banned");
    });

    it("tracks partial failures correctly", () => {
      tenantStatusStore.ensureExists("tenant-1");
      tenantStatusStore.ensureExists("tenant-2");
      tenantStatusStore.suspend("tenant-2", "prior", "admin-0");

      const result = store.bulkSuspend(
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
    it("reactivates multiple suspended tenants", () => {
      tenantStatusStore.ensureExists("tenant-1");
      tenantStatusStore.ensureExists("tenant-2");
      tenantStatusStore.suspend("tenant-1", "prior", "admin-0");
      tenantStatusStore.suspend("tenant-2", "prior", "admin-0");

      const result = store.bulkReactivate({ tenantIds: ["tenant-1", "tenant-2"] }, "admin-1");
      expect(result.succeeded).toBe(2);
      expect(tenantStatusStore.getStatus("tenant-1")).toBe("active");
      expect(tenantStatusStore.getStatus("tenant-2")).toBe("active");
    });

    it("skips already-active tenants", () => {
      tenantStatusStore.ensureExists("tenant-1");

      const result = store.bulkReactivate({ tenantIds: ["tenant-1"] }, "admin-1");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("Already active");
    });

    it("skips banned tenants", () => {
      tenantStatusStore.ensureExists("tenant-1");
      tenantStatusStore.ban("tenant-1", "tos violation", "admin-0");

      const result = store.bulkReactivate({ tenantIds: ["tenant-1"] }, "admin-1");
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain("banned");
    });
  });

  // ---------------------------------------------------------------------------
  // bulkExport
  // ---------------------------------------------------------------------------

  describe("bulkExport", () => {
    it("generates CSV with selected fields", () => {
      const result = store.bulkExport(
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
      expect(lines[0]).toBe("tenant_id,name,email,status,role,credit_balance_cents");
      expect(lines.length).toBe(3); // header + 2 data rows
    });

    it("generates CSV with all fields enabled", () => {
      const result = store.bulkExport(
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
        "tenant_id,name,email,status,role,credit_balance_cents,agent_count,lifetime_spend_cents,last_seen",
      );
    });

    it("handles empty result for valid tenant IDs with no matching rows", () => {
      const result = store.bulkExport(
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
    it("returns correct tenant info for preview", () => {
      const tenants = store.dryRun(["tenant-1", "tenant-2"]);
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
    it("returns filtered IDs matching status filter", () => {
      const ids = store.listMatchingTenantIds({ status: "active" });
      expect(ids).toContain("tenant-1");
      expect(ids).toContain("tenant-2");
      expect(ids).toContain("tenant-4");
      expect(ids).not.toContain("tenant-3"); // suspended
    });

    it("returns filtered IDs matching search filter", () => {
      const ids = store.listMatchingTenantIds({ search: "alice" });
      expect(ids).toEqual(["tenant-1"]);
    });

    it("returns all IDs with no filters", () => {
      const ids = store.listMatchingTenantIds({});
      expect(ids).toHaveLength(5);
    });
  });
});
