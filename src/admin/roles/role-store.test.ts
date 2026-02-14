import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidRole, RoleStore } from "./role-store.js";
import { initRolesSchema } from "./schema.js";

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initRolesSchema(db);
  return db;
}

describe("initRolesSchema", () => {
  it("creates user_roles table", () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_roles'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_user_roles_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initRolesSchema(db);
    initRolesSchema(db);
    db.close();
  });
});

describe("isValidRole", () => {
  it("accepts valid roles", () => {
    expect(isValidRole("platform_admin")).toBe(true);
    expect(isValidRole("tenant_admin")).toBe(true);
    expect(isValidRole("user")).toBe(true);
  });

  it("rejects invalid roles", () => {
    expect(isValidRole("admin")).toBe(false);
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
  });
});

describe("RoleStore", () => {
  let db: BetterSqlite3.Database;
  let store: RoleStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RoleStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("setRole / getRole", () => {
    it("sets and gets a role", () => {
      store.setRole("user-1", "tenant-1", "user", "admin-1");
      expect(store.getRole("user-1", "tenant-1")).toBe("user");
    });

    it("returns null for non-existent role", () => {
      expect(store.getRole("user-1", "tenant-1")).toBeNull();
    });

    it("upserts an existing role", () => {
      store.setRole("user-1", "tenant-1", "user", "admin-1");
      store.setRole("user-1", "tenant-1", "tenant_admin", "admin-2");
      expect(store.getRole("user-1", "tenant-1")).toBe("tenant_admin");
    });

    it("stores granted_by and granted_at", () => {
      store.setRole("user-1", "tenant-1", "user", "admin-1");
      const row = db
        .prepare("SELECT * FROM user_roles WHERE user_id = ? AND tenant_id = ?")
        .get("user-1", "tenant-1") as { granted_by: string; granted_at: number };
      expect(row.granted_by).toBe("admin-1");
      expect(row.granted_at).toBeGreaterThan(0);
    });

    it("handles null granted_by", () => {
      store.setRole("user-1", "tenant-1", "user", null);
      const row = db
        .prepare("SELECT * FROM user_roles WHERE user_id = ? AND tenant_id = ?")
        .get("user-1", "tenant-1") as { granted_by: string | null };
      expect(row.granted_by).toBeNull();
    });

    it("rejects invalid roles", () => {
      expect(() => store.setRole("user-1", "tenant-1", "superuser" as "user", "admin-1")).toThrow("Invalid role");
    });

    it("allows same user in different tenants", () => {
      store.setRole("user-1", "tenant-1", "user", "admin-1");
      store.setRole("user-1", "tenant-2", "tenant_admin", "admin-1");
      expect(store.getRole("user-1", "tenant-1")).toBe("user");
      expect(store.getRole("user-1", "tenant-2")).toBe("tenant_admin");
    });
  });

  describe("removeRole", () => {
    it("removes an existing role", () => {
      store.setRole("user-1", "tenant-1", "user", "admin-1");
      expect(store.removeRole("user-1", "tenant-1")).toBe(true);
      expect(store.getRole("user-1", "tenant-1")).toBeNull();
    });

    it("returns false for non-existent role", () => {
      expect(store.removeRole("user-1", "tenant-1")).toBe(false);
    });
  });

  describe("listByTenant", () => {
    it("lists all users in a tenant", () => {
      store.setRole("user-1", "tenant-1", "user", "admin-1");
      store.setRole("user-2", "tenant-1", "tenant_admin", "admin-1");
      store.setRole("user-3", "tenant-2", "user", "admin-1");

      const roles = store.listByTenant("tenant-1");
      expect(roles).toHaveLength(2);
      expect(roles.map((r) => r.user_id).sort()).toEqual(["user-1", "user-2"]);
    });

    it("returns empty array for tenant with no roles", () => {
      const roles = store.listByTenant("nonexistent");
      expect(roles).toHaveLength(0);
    });
  });

  describe("platform admin operations", () => {
    it("isPlatformAdmin returns true for platform admins", () => {
      store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      expect(store.isPlatformAdmin("admin-1")).toBe(true);
    });

    it("isPlatformAdmin returns false for non-admins", () => {
      expect(store.isPlatformAdmin("user-1")).toBe(false);
    });

    it("isPlatformAdmin returns false for tenant_admin", () => {
      store.setRole("user-1", RoleStore.PLATFORM_TENANT, "tenant_admin", null);
      expect(store.isPlatformAdmin("user-1")).toBe(false);
    });

    it("listPlatformAdmins returns all platform admins", () => {
      store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      store.setRole("admin-2", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      store.setRole("user-1", "tenant-1", "user", "admin-1");

      const admins = store.listPlatformAdmins();
      expect(admins).toHaveLength(2);
      expect(admins.map((a) => a.user_id).sort()).toEqual(["admin-1", "admin-2"]);
    });

    it("countPlatformAdmins returns correct count", () => {
      expect(store.countPlatformAdmins()).toBe(0);

      store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      expect(store.countPlatformAdmins()).toBe(1);

      store.setRole("admin-2", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      expect(store.countPlatformAdmins()).toBe(2);
    });
  });
});
