import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminUsersApiRoutes } from "../../api/routes/admin-users.js";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import { createTestDb as createMigratedTestDb, truncateAllTables } from "../../test/db.js";
import { AdminUserStore } from "./user-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ db: DrizzleDb; pool: PGlite }> {
  return createMigratedTestDb();
}

async function insertUser(
  db: DrizzleDb,
  overrides: Partial<{
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    status: string;
    role: string;
    creditBalanceCredits: number;
    agentCount: number;
    lastSeen: number | null;
    createdAt: number;
  }> = {},
): Promise<void> {
  const defaults = {
    id: `user-${Math.random().toString(36).slice(2, 8)}`,
    email: `user-${Math.random().toString(36).slice(2, 8)}@example.com`,
    name: "Test User",
    tenantId: "tenant-1",
    status: "active",
    role: "user",
    creditBalanceCredits: 1000,
    agentCount: 2,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  await db.insert(adminUsers).values({ ...defaults, ...overrides });
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("admin_users schema (via Drizzle migration)", () => {
  it("creates admin_users table and enforces status CHECK constraint", async () => {
    const { db, pool } = await createTestDb();
    await expect(
      db.insert(adminUsers).values({
        id: "u1",
        email: "a@b.com",
        tenantId: "t1",
        status: "invalid_status",
        role: "user",
        creditBalanceCredits: 0,
        agentCount: 0,
        createdAt: Date.now(),
      }),
    ).rejects.toThrow();
    await pool.close();
  });

  it("enforces role CHECK constraint", async () => {
    const { db, pool } = await createTestDb();
    await expect(
      db.insert(adminUsers).values({
        id: "u1",
        email: "a@b.com",
        tenantId: "t1",
        status: "active",
        role: "invalid_role",
        creditBalanceCredits: 0,
        agentCount: 0,
        createdAt: Date.now(),
      }),
    ).rejects.toThrow();
    await pool.close();
  });

  it("enforces PRIMARY KEY uniqueness", async () => {
    const { db, pool } = await createTestDb();
    await db.insert(adminUsers).values({ id: "dup", email: "a@b.com", tenantId: "t1", createdAt: Date.now() });
    await expect(
      db.insert(adminUsers).values({ id: "dup", email: "b@b.com", tenantId: "t2", createdAt: Date.now() }),
    ).rejects.toThrow();
    await pool.close();
  });

  it("allows NULL for name and last_seen", async () => {
    const { db, pool } = await createTestDb();
    await db.insert(adminUsers).values({
      id: "u-null",
      email: "a@b.com",
      name: null,
      tenantId: "t1",
      createdAt: Date.now(),
    });
    const rows = await db
      .select({ name: adminUsers.name, lastSeen: adminUsers.lastSeen })
      .from(adminUsers)
      .where(((t) => require("drizzle-orm").eq(t.id, "u-null"))(adminUsers));
    expect(rows[0].name).toBeNull();
    expect(rows[0].lastSeen).toBeNull();
    await pool.close();
  });

  it("provides correct defaults", async () => {
    const { db, pool } = await createTestDb();
    await db.insert(adminUsers).values({ id: "u-defaults", email: "a@b.com", tenantId: "t1", createdAt: Date.now() });
    const rows = await db
      .select({
        status: adminUsers.status,
        role: adminUsers.role,
        creditBalanceCredits: adminUsers.creditBalanceCredits,
        agentCount: adminUsers.agentCount,
      })
      .from(adminUsers)
      .where(((t) => require("drizzle-orm").eq(t.id, "u-defaults"))(adminUsers));
    expect(rows[0].status).toBe("active");
    expect(rows[0].role).toBe("user");
    expect(rows[0].creditBalanceCredits).toBe(0);
    expect(rows[0].agentCount).toBe(0);
    await pool.close();
  });
});

// ---------------------------------------------------------------------------
// AdminUserStore.list
// ---------------------------------------------------------------------------

describe("AdminUserStore.list", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: AdminUserStore;

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
    store = new AdminUserStore(db);
  });

  it("returns empty list when no users", async () => {
    const result = await store.list();
    expect(result.users).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
  });

  it("returns all users with default pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await insertUser(db, { id: `user-${i}` });
    }
    const result = await store.list();
    expect(result.users).toHaveLength(5);
    expect(result.total).toBe(5);
  });

  it("paginates with limit and offset", async () => {
    for (let i = 0; i < 10; i++) {
      await insertUser(db, { id: `user-${i}`, createdAt: Date.now() + i });
    }
    const page1 = await store.list({ limit: 3, offset: 0 });
    expect(page1.users).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.limit).toBe(3);
    expect(page1.offset).toBe(0);

    const page2 = await store.list({ limit: 3, offset: 3 });
    expect(page2.users).toHaveLength(3);
    expect(page2.users[0].id).not.toBe(page1.users[0].id);
  });

  it("caps limit at 100", async () => {
    for (let i = 0; i < 5; i++) {
      await insertUser(db, { id: `user-${i}` });
    }
    const result = await store.list({ limit: 999 });
    expect(result.limit).toBe(100);
  });

  it("filters by status", async () => {
    await insertUser(db, { id: "active-1", status: "active" });
    await insertUser(db, { id: "suspended-1", status: "suspended" });
    await insertUser(db, { id: "dormant-1", status: "dormant" });

    const result = await store.list({ status: "suspended" });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("suspended-1");
    expect(result.total).toBe(1);
  });

  it("filters by role", async () => {
    await insertUser(db, { id: "admin-1", role: "platform_admin" });
    await insertUser(db, { id: "user-1", role: "user" });
    await insertUser(db, { id: "tenant-admin-1", role: "tenant_admin" });

    const result = await store.list({ role: "platform_admin" });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("admin-1");
  });

  it("filters by hasCredits", async () => {
    await insertUser(db, { id: "rich", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "broke", creditBalanceCredits: 0 });

    const result = await store.list({ hasCredits: true });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("rich");
  });

  it("filters users with no credits when hasCredits is false", async () => {
    await insertUser(db, { id: "rich", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "broke", creditBalanceCredits: 0 });

    const result = await store.list({ hasCredits: false });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("broke");
  });

  it("filters by lowBalance", async () => {
    await insertUser(db, { id: "low", creditBalanceCredits: 200 });
    await insertUser(db, { id: "high", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "zero", creditBalanceCredits: 0 });

    const result = await store.list({ lowBalance: true });
    expect(result.users).toHaveLength(2);
    const ids = result.users.map((u) => u.id);
    expect(ids).toContain("low");
    expect(ids).toContain("zero");
  });

  it("searches across name, email, and tenant_id", async () => {
    await insertUser(db, { id: "u1", name: "Alice Smith", email: "alice@example.com", tenantId: "acme" });
    await insertUser(db, { id: "u2", name: "Bob Jones", email: "bob@example.com", tenantId: "globex" });
    await insertUser(db, { id: "u3", name: "Charlie", email: "charlie@acme.io", tenantId: "other" });

    const result = await store.list({ search: "acme" });
    expect(result.users).toHaveLength(2);
    const ids = result.users.map((u) => u.id);
    expect(ids).toContain("u1"); // tenant_id match
    expect(ids).toContain("u3"); // email match
  });

  it("search is case-insensitive (via LIKE)", async () => {
    await insertUser(db, { id: "u1", name: "Alice Smith" });
    const result = await store.list({ search: "alice" });
    expect(result.users).toHaveLength(1);
  });

  it("search escapes LIKE wildcards", async () => {
    await insertUser(db, { id: "u1", name: "100% complete" });
    await insertUser(db, { id: "u2", name: "not a match" });

    const result = await store.list({ search: "100%" });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("u1");
  });

  it("sorts by created_at descending by default", async () => {
    await insertUser(db, { id: "old", createdAt: 1000 });
    await insertUser(db, { id: "new", createdAt: 2000 });

    const result = await store.list();
    expect(result.users[0].id).toBe("new");
    expect(result.users[1].id).toBe("old");
  });

  it("sorts by created_at ascending", async () => {
    await insertUser(db, { id: "old", createdAt: 1000 });
    await insertUser(db, { id: "new", createdAt: 2000 });

    const result = await store.list({ sortBy: "created_at", sortOrder: "asc" });
    expect(result.users[0].id).toBe("old");
    expect(result.users[1].id).toBe("new");
  });

  it("sorts by balance", async () => {
    await insertUser(db, { id: "low", creditBalanceCredits: 100, createdAt: 1000 });
    await insertUser(db, { id: "high", creditBalanceCredits: 5000, createdAt: 2000 });

    const result = await store.list({ sortBy: "balance", sortOrder: "desc" });
    expect(result.users[0].id).toBe("high");
    expect(result.users[1].id).toBe("low");
  });

  it("sorts by agent_count", async () => {
    await insertUser(db, { id: "few", agentCount: 1, createdAt: 1000 });
    await insertUser(db, { id: "many", agentCount: 10, createdAt: 2000 });

    const result = await store.list({ sortBy: "agent_count", sortOrder: "desc" });
    expect(result.users[0].id).toBe("many");
    expect(result.users[1].id).toBe("few");
  });

  it("sorts by last_seen", async () => {
    await insertUser(db, { id: "recent", lastSeen: 2000, createdAt: 1000 });
    await insertUser(db, { id: "stale", lastSeen: 1000, createdAt: 2000 });

    const result = await store.list({ sortBy: "last_seen", sortOrder: "desc" });
    expect(result.users[0].id).toBe("recent");
    expect(result.users[1].id).toBe("stale");
  });

  it("combines multiple filters", async () => {
    await insertUser(db, { id: "match", status: "active", role: "user", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "wrong-status", status: "suspended", role: "user", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "wrong-role", status: "active", role: "platform_admin", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "no-credits", status: "active", role: "user", creditBalanceCredits: 0 });

    const result = await store.list({ status: "active", role: "user", hasCredits: true });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// AdminUserStore.search
// ---------------------------------------------------------------------------

describe("AdminUserStore.search", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: AdminUserStore;

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
    store = new AdminUserStore(db);
  });

  it("searches by name", async () => {
    await insertUser(db, { id: "u1", name: "Alice Smith" });
    await insertUser(db, { id: "u2", name: "Bob Jones" });

    const results = await store.search("Alice");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("u1");
  });

  it("searches by email", async () => {
    await insertUser(db, { id: "u1", email: "alice@example.com" });
    await insertUser(db, { id: "u2", email: "bob@other.com" });

    const results = await store.search("example.com");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("u1");
  });

  it("searches by tenant_id", async () => {
    await insertUser(db, { id: "u1", tenantId: "acme-corp" });
    await insertUser(db, { id: "u2", tenantId: "globex" });

    const results = await store.search("acme");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("u1");
  });

  it("returns empty array when no matches", async () => {
    await insertUser(db, { id: "u1", name: "Alice" });
    const results = await store.search("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("limits results to 50", async () => {
    for (let i = 0; i < 60; i++) {
      await insertUser(db, { id: `user-${i}`, name: "Searchable Name" });
    }
    const results = await store.search("Searchable");
    expect(results).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// AdminUserStore.getById
// ---------------------------------------------------------------------------

describe("AdminUserStore.getById", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: AdminUserStore;

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
    store = new AdminUserStore(db);
  });

  it("returns user by ID", async () => {
    await insertUser(db, {
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      tenantId: "acme",
      status: "active",
      role: "user",
      creditBalanceCredits: 1500,
      agentCount: 3,
      lastSeen: 1700000000000,
      createdAt: 1600000000000,
    });

    const user = await store.getById("user-1");
    expect(user).not.toBeNull();
    expect(user?.id).toBe("user-1");
    expect(user?.email).toBe("alice@example.com");
    expect(user?.name).toBe("Alice");
    expect(user?.tenant_id).toBe("acme");
    expect(user?.status).toBe("active");
    expect(user?.role).toBe("user");
    expect(user?.credit_balance_credits).toBe(1500);
    expect(user?.agent_count).toBe(3);
    expect(user?.last_seen).toBe(1700000000000);
    expect(user?.created_at).toBe(1600000000000);
  });

  it("returns null for nonexistent user", async () => {
    const user = await store.getById("nonexistent");
    expect(user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API Route tests
// ---------------------------------------------------------------------------

describe("admin users API routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;

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
  });

  it("GET / returns paginated user list", async () => {
    for (let i = 0; i < 5; i++) {
      await insertUser(db, { id: `user-${i}` });
    }

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[]; total: number; limit: number; offset: number };
    expect(body.users).toHaveLength(5);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(0);
  });

  it("GET / supports search filter", async () => {
    await insertUser(db, { id: "u1", name: "Alice Smith" });
    await insertUser(db, { id: "u2", name: "Bob Jones" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?search=Alice");
    const body = (await res.json()) as { users: { id: string }[]; total: number };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("u1");
  });

  it("GET / supports status filter", async () => {
    await insertUser(db, { id: "active-1", status: "active" });
    await insertUser(db, { id: "suspended-1", status: "suspended" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?status=suspended");
    const body = (await res.json()) as { users: { id: string }[]; total: number };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("suspended-1");
  });

  it("GET / supports role filter", async () => {
    await insertUser(db, { id: "admin-1", role: "platform_admin" });
    await insertUser(db, { id: "user-1", role: "user" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?role=platform_admin");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("admin-1");
  });

  it("GET / supports hasCredits filter", async () => {
    await insertUser(db, { id: "rich", creditBalanceCredits: 5000 });
    await insertUser(db, { id: "broke", creditBalanceCredits: 0 });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?hasCredits=true");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("rich");
  });

  it("GET / supports sorting", async () => {
    await insertUser(db, { id: "old", createdAt: 1000 });
    await insertUser(db, { id: "new", createdAt: 2000 });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?sortBy=created_at&sortOrder=asc");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users[0].id).toBe("old");
    expect(body.users[1].id).toBe("new");
  });

  it("GET / supports pagination", async () => {
    for (let i = 0; i < 10; i++) {
      await insertUser(db, { id: `user-${i}` });
    }

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?limit=3&offset=0");
    const body = (await res.json()) as { users: unknown[]; total: number; limit: number; offset: number };
    expect(body.users).toHaveLength(3);
    expect(body.total).toBe(10);
    expect(body.limit).toBe(3);
  });

  it("GET / ignores invalid status filter", async () => {
    await insertUser(db, { id: "u1", status: "active" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?status=invalid");
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toHaveLength(1);
  });

  it("GET /:userId returns single user", async () => {
    await insertUser(db, { id: "user-42", email: "alice@example.com", name: "Alice" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users/user-42");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string; name: string };
    expect(body.id).toBe("user-42");
    expect(body.email).toBe("alice@example.com");
    expect(body.name).toBe("Alice");
  });

  it("GET /:userId returns 404 for nonexistent user", async () => {
    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users/nonexistent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("User not found");
  });

  it("GET / supports lowBalance filter", async () => {
    await insertUser(db, { id: "low", creditBalanceCredits: 200 });
    await insertUser(db, { id: "high", creditBalanceCredits: 5000 });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?lowBalance=true");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("low");
  });
});
