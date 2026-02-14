import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { TenantStatusStore } from "./tenant-status-store.js";

describe("TenantStatusStore", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let store: TenantStatusStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new TenantStatusStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // ---------------------------------------------------------------------------
  // get / getStatus / ensureExists
  // ---------------------------------------------------------------------------

  describe("get", () => {
    it("returns null for unknown tenant", () => {
      expect(store.get("unknown-tenant")).toBeNull();
    });

    it("returns the row after ensureExists", () => {
      store.ensureExists("tenant-1");
      const row = store.get("tenant-1");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("active");
      expect(row?.statusReason).toBeNull();
    });
  });

  describe("getStatus", () => {
    it("returns 'active' for unknown tenant (default)", () => {
      expect(store.getStatus("unknown")).toBe("active");
    });

    it("returns the stored status", () => {
      store.ensureExists("tenant-1");
      store.suspend("tenant-1", "test reason", "admin-1");
      expect(store.getStatus("tenant-1")).toBe("suspended");
    });
  });

  describe("ensureExists", () => {
    it("creates a row with active status", () => {
      store.ensureExists("tenant-1");
      expect(store.getStatus("tenant-1")).toBe("active");
    });

    it("is idempotent", () => {
      store.ensureExists("tenant-1");
      store.ensureExists("tenant-1");
      expect(store.getStatus("tenant-1")).toBe("active");
    });

    it("does not overwrite existing status", () => {
      store.ensureExists("tenant-1");
      store.suspend("tenant-1", "reason", "admin-1");
      store.ensureExists("tenant-1");
      expect(store.getStatus("tenant-1")).toBe("suspended");
    });
  });

  // ---------------------------------------------------------------------------
  // suspend
  // ---------------------------------------------------------------------------

  describe("suspend", () => {
    it("transitions tenant to suspended", () => {
      store.suspend("tenant-1", "ToS violation", "admin-1");
      const row = store.get("tenant-1");
      expect(row?.status).toBe("suspended");
      expect(row?.statusReason).toBe("ToS violation");
      expect(row?.statusChangedBy).toBe("admin-1");
      expect(row?.statusChangedAt).toBeGreaterThan(0);
    });

    it("clears grace deadline on suspension", () => {
      store.setGracePeriod("tenant-1");
      expect(store.get("tenant-1")?.graceDeadline).not.toBeNull();

      store.suspend("tenant-1", "expired", "admin-1");
      expect(store.get("tenant-1")?.graceDeadline).toBeNull();
    });

    it("creates the row if tenant does not exist", () => {
      store.suspend("new-tenant", "reason", "admin-1");
      expect(store.getStatus("new-tenant")).toBe("suspended");
    });
  });

  // ---------------------------------------------------------------------------
  // reactivate
  // ---------------------------------------------------------------------------

  describe("reactivate", () => {
    it("transitions suspended tenant to active", () => {
      store.suspend("tenant-1", "reason", "admin-1");
      store.reactivate("tenant-1", "admin-2");

      const row = store.get("tenant-1");
      expect(row?.status).toBe("active");
      expect(row?.statusReason).toBeNull();
      expect(row?.statusChangedBy).toBe("admin-2");
    });

    it("clears grace deadline on reactivation", () => {
      store.setGracePeriod("tenant-1");
      store.reactivate("tenant-1", "admin-1");
      expect(store.get("tenant-1")?.graceDeadline).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // ban
  // ---------------------------------------------------------------------------

  describe("ban", () => {
    it("transitions tenant to banned", () => {
      store.ban("tenant-1", "ToS 5.2 violation", "admin-1");
      const row = store.get("tenant-1");
      expect(row?.status).toBe("banned");
      expect(row?.statusReason).toBe("ToS 5.2 violation");
      expect(row?.statusChangedBy).toBe("admin-1");
      expect(row?.dataDeleteAfter).not.toBeNull();
    });

    it("sets data deletion deadline", () => {
      store.ban("tenant-1", "violation", "admin-1");
      const row = store.get("tenant-1");
      expect(row?.dataDeleteAfter).toBeTruthy();
    });

    it("creates the row if tenant does not exist", () => {
      store.ban("new-tenant", "reason", "admin-1");
      expect(store.getStatus("new-tenant")).toBe("banned");
    });
  });

  // ---------------------------------------------------------------------------
  // setGracePeriod
  // ---------------------------------------------------------------------------

  describe("setGracePeriod", () => {
    it("transitions tenant to grace_period", () => {
      store.setGracePeriod("tenant-1");
      const row = store.get("tenant-1");
      expect(row?.status).toBe("grace_period");
      expect(row?.graceDeadline).not.toBeNull();
    });

    it("creates row if not exists", () => {
      store.setGracePeriod("new-tenant");
      expect(store.getStatus("new-tenant")).toBe("grace_period");
    });
  });

  // ---------------------------------------------------------------------------
  // expireGracePeriods
  // ---------------------------------------------------------------------------

  describe("expireGracePeriods", () => {
    it("suspends tenants whose grace period has expired", () => {
      store.setGracePeriod("tenant-1");

      // Manually set grace_deadline to the past
      sqlite.exec(`
        UPDATE tenant_status
        SET grace_deadline = datetime('now', '-1 day')
        WHERE tenant_id = 'tenant-1'
      `);

      const expired = store.expireGracePeriods();
      expect(expired).toEqual(["tenant-1"]);
      expect(store.getStatus("tenant-1")).toBe("suspended");
      expect(store.get("tenant-1")?.statusReason).toBe("Grace period expired");
      expect(store.get("tenant-1")?.statusChangedBy).toBe("system");
    });

    it("does not suspend tenants still within grace period", () => {
      store.setGracePeriod("tenant-1");

      const expired = store.expireGracePeriods();
      expect(expired).toEqual([]);
      expect(store.getStatus("tenant-1")).toBe("grace_period");
    });

    it("returns empty array when no grace period tenants exist", () => {
      const expired = store.expireGracePeriods();
      expect(expired).toEqual([]);
    });

    it("handles multiple expired tenants", () => {
      store.setGracePeriod("tenant-1");
      store.setGracePeriod("tenant-2");
      store.setGracePeriod("tenant-3");

      // Expire first two
      sqlite.exec(`
        UPDATE tenant_status
        SET grace_deadline = datetime('now', '-1 day')
        WHERE tenant_id IN ('tenant-1', 'tenant-2')
      `);

      const expired = store.expireGracePeriods();
      expect(expired.sort()).toEqual(["tenant-1", "tenant-2"]);
      expect(store.getStatus("tenant-1")).toBe("suspended");
      expect(store.getStatus("tenant-2")).toBe("suspended");
      expect(store.getStatus("tenant-3")).toBe("grace_period");
    });
  });

  // ---------------------------------------------------------------------------
  // isOperational
  // ---------------------------------------------------------------------------

  describe("isOperational", () => {
    it("returns true for active tenant", () => {
      store.ensureExists("tenant-1");
      expect(store.isOperational("tenant-1")).toBe(true);
    });

    it("returns true for unknown tenant (defaults to active)", () => {
      expect(store.isOperational("unknown")).toBe(true);
    });

    it("returns true for grace_period tenant", () => {
      store.setGracePeriod("tenant-1");
      expect(store.isOperational("tenant-1")).toBe(true);
    });

    it("returns false for suspended tenant", () => {
      store.suspend("tenant-1", "reason", "admin-1");
      expect(store.isOperational("tenant-1")).toBe(false);
    });

    it("returns false for banned tenant", () => {
      store.ban("tenant-1", "reason", "admin-1");
      expect(store.isOperational("tenant-1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("active -> suspended -> active (reactivated)", () => {
      store.ensureExists("tenant-1");
      expect(store.getStatus("tenant-1")).toBe("active");

      store.suspend("tenant-1", "review needed", "admin-1");
      expect(store.getStatus("tenant-1")).toBe("suspended");

      store.reactivate("tenant-1", "admin-2");
      expect(store.getStatus("tenant-1")).toBe("active");
      expect(store.get("tenant-1")?.statusReason).toBeNull();
    });

    it("active -> grace_period -> suspended (expired)", () => {
      store.ensureExists("tenant-1");
      store.setGracePeriod("tenant-1");
      expect(store.getStatus("tenant-1")).toBe("grace_period");

      // Simulate expiration
      sqlite.exec(`
        UPDATE tenant_status
        SET grace_deadline = datetime('now', '-1 day')
        WHERE tenant_id = 'tenant-1'
      `);

      store.expireGracePeriods();
      expect(store.getStatus("tenant-1")).toBe("suspended");
    });

    it("active -> grace_period -> active (topped up)", () => {
      store.ensureExists("tenant-1");
      store.setGracePeriod("tenant-1");
      store.reactivate("tenant-1", "system");
      expect(store.getStatus("tenant-1")).toBe("active");
    });

    it("active -> banned (permanent)", () => {
      store.ensureExists("tenant-1");
      store.ban("tenant-1", "ToS violation", "admin-1");
      expect(store.getStatus("tenant-1")).toBe("banned");
      expect(store.get("tenant-1")?.dataDeleteAfter).not.toBeNull();
    });
  });
});
