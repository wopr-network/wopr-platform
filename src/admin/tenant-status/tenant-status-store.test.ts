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
    it("returns null for unknown tenant", async () => {
      expect(await store.get("unknown-tenant")).toBeNull();
    });

    it("returns the row after ensureExists", async () => {
      await store.ensureExists("tenant-1");
      const row = await store.get("tenant-1");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("active");
      expect(row?.statusReason).toBeNull();
    });
  });

  describe("getStatus", () => {
    it("returns 'active' for unknown tenant (default)", async () => {
      expect(await store.getStatus("unknown")).toBe("active");
    });

    it("returns the stored status", async () => {
      await store.ensureExists("tenant-1");
      await store.suspend("tenant-1", "test reason", "admin-1");
      expect(await store.getStatus("tenant-1")).toBe("suspended");
    });
  });

  describe("ensureExists", () => {
    it("creates a row with active status", async () => {
      await store.ensureExists("tenant-1");
      expect(await store.getStatus("tenant-1")).toBe("active");
    });

    it("is idempotent", async () => {
      await store.ensureExists("tenant-1");
      await store.ensureExists("tenant-1");
      expect(await store.getStatus("tenant-1")).toBe("active");
    });

    it("does not overwrite existing status", async () => {
      await store.ensureExists("tenant-1");
      await store.suspend("tenant-1", "reason", "admin-1");
      await store.ensureExists("tenant-1");
      expect(await store.getStatus("tenant-1")).toBe("suspended");
    });
  });

  // ---------------------------------------------------------------------------
  // suspend
  // ---------------------------------------------------------------------------

  describe("suspend", () => {
    it("transitions tenant to suspended", async () => {
      await store.suspend("tenant-1", "ToS violation", "admin-1");
      const row = await store.get("tenant-1");
      expect(row?.status).toBe("suspended");
      expect(row?.statusReason).toBe("ToS violation");
      expect(row?.statusChangedBy).toBe("admin-1");
      expect(row?.statusChangedAt).toBeGreaterThan(0);
    });

    it("clears grace deadline on suspension", async () => {
      await store.setGracePeriod("tenant-1");
      expect((await store.get("tenant-1"))?.graceDeadline).not.toBeNull();

      await store.suspend("tenant-1", "expired", "admin-1");
      expect((await store.get("tenant-1"))?.graceDeadline).toBeNull();
    });

    it("creates the row if tenant does not exist", async () => {
      await store.suspend("new-tenant", "reason", "admin-1");
      expect(await store.getStatus("new-tenant")).toBe("suspended");
    });
  });

  // ---------------------------------------------------------------------------
  // reactivate
  // ---------------------------------------------------------------------------

  describe("reactivate", () => {
    it("transitions suspended tenant to active", async () => {
      await store.suspend("tenant-1", "reason", "admin-1");
      await store.reactivate("tenant-1", "admin-2");

      const row = await store.get("tenant-1");
      expect(row?.status).toBe("active");
      expect(row?.statusReason).toBeNull();
      expect(row?.statusChangedBy).toBe("admin-2");
    });

    it("clears grace deadline on reactivation", async () => {
      await store.setGracePeriod("tenant-1");
      await store.reactivate("tenant-1", "admin-1");
      expect((await store.get("tenant-1"))?.graceDeadline).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // ban
  // ---------------------------------------------------------------------------

  describe("ban", () => {
    it("transitions tenant to banned", async () => {
      await store.ban("tenant-1", "ToS 5.2 violation", "admin-1");
      const row = await store.get("tenant-1");
      expect(row?.status).toBe("banned");
      expect(row?.statusReason).toBe("ToS 5.2 violation");
      expect(row?.statusChangedBy).toBe("admin-1");
      expect(row?.dataDeleteAfter).not.toBeNull();
    });

    it("sets data deletion deadline", async () => {
      await store.ban("tenant-1", "violation", "admin-1");
      const row = await store.get("tenant-1");
      expect(row?.dataDeleteAfter).toBeTruthy();
    });

    it("creates the row if tenant does not exist", async () => {
      await store.ban("new-tenant", "reason", "admin-1");
      expect(await store.getStatus("new-tenant")).toBe("banned");
    });
  });

  // ---------------------------------------------------------------------------
  // setGracePeriod
  // ---------------------------------------------------------------------------

  describe("setGracePeriod", () => {
    it("transitions tenant to grace_period", async () => {
      await store.setGracePeriod("tenant-1");
      const row = await store.get("tenant-1");
      expect(row?.status).toBe("grace_period");
      expect(row?.graceDeadline).not.toBeNull();
    });

    it("creates row if not exists", async () => {
      await store.setGracePeriod("new-tenant");
      expect(await store.getStatus("new-tenant")).toBe("grace_period");
    });
  });

  // ---------------------------------------------------------------------------
  // expireGracePeriods
  // ---------------------------------------------------------------------------

  describe("expireGracePeriods", () => {
    it("suspends tenants whose grace period has expired", async () => {
      await store.setGracePeriod("tenant-1");

      // Manually set grace_deadline to the past
      sqlite.exec(`
        UPDATE tenant_status
        SET grace_deadline = datetime('now', '-1 day')
        WHERE tenant_id = 'tenant-1'
      `);

      const expired = await store.expireGracePeriods();
      expect(expired).toEqual(["tenant-1"]);
      expect(await store.getStatus("tenant-1")).toBe("suspended");
      expect((await store.get("tenant-1"))?.statusReason).toBe("Grace period expired");
      expect((await store.get("tenant-1"))?.statusChangedBy).toBe("system");
    });

    it("does not suspend tenants still within grace period", async () => {
      await store.setGracePeriod("tenant-1");

      const expired = await store.expireGracePeriods();
      expect(expired).toEqual([]);
      expect(await store.getStatus("tenant-1")).toBe("grace_period");
    });

    it("returns empty array when no grace period tenants exist", async () => {
      const expired = await store.expireGracePeriods();
      expect(expired).toEqual([]);
    });

    it("handles multiple expired tenants", async () => {
      await store.setGracePeriod("tenant-1");
      await store.setGracePeriod("tenant-2");
      await store.setGracePeriod("tenant-3");

      // Expire first two
      sqlite.exec(`
        UPDATE tenant_status
        SET grace_deadline = datetime('now', '-1 day')
        WHERE tenant_id IN ('tenant-1', 'tenant-2')
      `);

      const expired = await store.expireGracePeriods();
      expect(expired.sort()).toEqual(["tenant-1", "tenant-2"]);
      expect(await store.getStatus("tenant-1")).toBe("suspended");
      expect(await store.getStatus("tenant-2")).toBe("suspended");
      expect(await store.getStatus("tenant-3")).toBe("grace_period");
    });
  });

  // ---------------------------------------------------------------------------
  // isOperational
  // ---------------------------------------------------------------------------

  describe("isOperational", () => {
    it("returns true for active tenant", async () => {
      await store.ensureExists("tenant-1");
      expect(await store.isOperational("tenant-1")).toBe(true);
    });

    it("returns true for unknown tenant (defaults to active)", async () => {
      expect(await store.isOperational("unknown")).toBe(true);
    });

    it("returns true for grace_period tenant", async () => {
      await store.setGracePeriod("tenant-1");
      expect(await store.isOperational("tenant-1")).toBe(true);
    });

    it("returns false for suspended tenant", async () => {
      await store.suspend("tenant-1", "reason", "admin-1");
      expect(await store.isOperational("tenant-1")).toBe(false);
    });

    it("returns false for banned tenant", async () => {
      await store.ban("tenant-1", "reason", "admin-1");
      expect(await store.isOperational("tenant-1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("active -> suspended -> active (reactivated)", async () => {
      await store.ensureExists("tenant-1");
      expect(await store.getStatus("tenant-1")).toBe("active");

      await store.suspend("tenant-1", "review needed", "admin-1");
      expect(await store.getStatus("tenant-1")).toBe("suspended");

      await store.reactivate("tenant-1", "admin-2");
      expect(await store.getStatus("tenant-1")).toBe("active");
      expect((await store.get("tenant-1"))?.statusReason).toBeNull();
    });

    it("active -> grace_period -> suspended (expired)", async () => {
      await store.ensureExists("tenant-1");
      await store.setGracePeriod("tenant-1");
      expect(await store.getStatus("tenant-1")).toBe("grace_period");

      // Simulate expiration
      sqlite.exec(`
        UPDATE tenant_status
        SET grace_deadline = datetime('now', '-1 day')
        WHERE tenant_id = 'tenant-1'
      `);

      await store.expireGracePeriods();
      expect(await store.getStatus("tenant-1")).toBe("suspended");
    });

    it("active -> grace_period -> active (topped up)", async () => {
      await store.ensureExists("tenant-1");
      await store.setGracePeriod("tenant-1");
      await store.reactivate("tenant-1", "system");
      expect(await store.getStatus("tenant-1")).toBe("active");
    });

    it("active -> banned (permanent)", async () => {
      await store.ensureExists("tenant-1");
      await store.ban("tenant-1", "ToS violation", "admin-1");
      expect(await store.getStatus("tenant-1")).toBe("banned");
      expect((await store.get("tenant-1"))?.dataDeleteAfter).not.toBeNull();
    });
  });
});
