import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminUsersApiRoutes } from "../../api/routes/admin-users.js";
import { initAdminUsersSchema } from "./schema.js";
import { AdminUserStore } from "./user-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  initAdminUsersSchema(db);
  return db;
}

function insertUser(
  db: BetterSqlite3.Database,
  overrides: Partial<{
    id: string;
    email: string;
    name: string | null;
    tenant_id: string;
    status: string;
    role: string;
    credit_balance_cents: number;
    agent_count: number;
    last_seen: number | null;
    created_at: number;
  }> = {},
): void {
  const defaults = {
    id: `user-${Math.random().toString(36).slice(2, 8)}`,
    email: `user-${Math.random().toString(36).slice(2, 8)}@example.com`,
    name: "Test User",
    tenant_id: "tenant-1",
    status: "active",
    role: "user",
    credit_balance_cents: 1000,
    agent_count: 2,
    last_seen: Date.now(),
    created_at: Date.now(),
  };
  const row = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO admin_users (id, email, name, tenant_id, status, role, credit_balance_cents, agent_count, last_seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.email,
    row.name,
    row.tenant_id,
    row.status,
    row.role,
    row.credit_balance_cents,
    row.agent_count,
    row.last_seen,
    row.created_at,
  );
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("initAdminUsersSchema", () => {
  it("creates admin_users table", () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_users'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates expected indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_admin_users_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(6);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initAdminUsersSchema(db);
    initAdminUsersSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_users'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("enforces status CHECK constraint", () => {
    const db = createTestDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO admin_users (id, email, tenant_id, status, role, credit_balance_cents, agent_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("u1", "a@b.com", "t1", "invalid_status", "user", 0, 0, Date.now()),
    ).toThrow();
    db.close();
  });

  it("enforces role CHECK constraint", () => {
    const db = createTestDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO admin_users (id, email, tenant_id, status, role, credit_balance_cents, agent_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("u1", "a@b.com", "t1", "active", "invalid_role", 0, 0, Date.now()),
    ).toThrow();
    db.close();
  });

  it("enforces NOT NULL on email", () => {
    const db = createTestDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO admin_users (id, email, tenant_id, status, role, credit_balance_cents, agent_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("u1", null, "t1", "active", "user", 0, 0, Date.now()),
    ).toThrow();
    db.close();
  });

  it("enforces NOT NULL on tenant_id", () => {
    const db = createTestDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO admin_users (id, email, tenant_id, status, role, credit_balance_cents, agent_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("u1", "a@b.com", null, "active", "user", 0, 0, Date.now()),
    ).toThrow();
    db.close();
  });

  it("enforces PRIMARY KEY uniqueness", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO admin_users (id, email, tenant_id, status, role, credit_balance_cents, agent_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("dup", "a@b.com", "t1", "active", "user", 0, 0, Date.now());
    expect(() =>
      db
        .prepare(
          "INSERT INTO admin_users (id, email, tenant_id, status, role, credit_balance_cents, agent_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("dup", "b@b.com", "t2", "active", "user", 0, 0, Date.now()),
    ).toThrow();
    db.close();
  });

  it("allows NULL for name and last_seen", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO admin_users (id, email, name, tenant_id, status, role, credit_balance_cents, agent_count, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("u-null", "a@b.com", null, "t1", "active", "user", 0, 0, null, Date.now());
    const row = db.prepare("SELECT name, last_seen FROM admin_users WHERE id = ?").get("u-null") as {
      name: string | null;
      last_seen: number | null;
    };
    expect(row.name).toBeNull();
    expect(row.last_seen).toBeNull();
    db.close();
  });

  it("provides correct defaults", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO admin_users (id, email, tenant_id, created_at) VALUES (?, ?, ?, ?)").run(
      "u-defaults",
      "a@b.com",
      "t1",
      Date.now(),
    );
    const row = db
      .prepare("SELECT status, role, credit_balance_cents, agent_count FROM admin_users WHERE id = ?")
      .get("u-defaults") as { status: string; role: string; credit_balance_cents: number; agent_count: number };
    expect(row.status).toBe("active");
    expect(row.role).toBe("user");
    expect(row.credit_balance_cents).toBe(0);
    expect(row.agent_count).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AdminUserStore.list
// ---------------------------------------------------------------------------

describe("AdminUserStore.list", () => {
  let db: BetterSqlite3.Database;
  let store: AdminUserStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AdminUserStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty list when no users", () => {
    const result = store.list();
    expect(result.users).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
  });

  it("returns all users with default pagination", () => {
    for (let i = 0; i < 5; i++) {
      insertUser(db, { id: `user-${i}` });
    }
    const result = store.list();
    expect(result.users).toHaveLength(5);
    expect(result.total).toBe(5);
  });

  it("paginates with limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      insertUser(db, { id: `user-${i}`, created_at: Date.now() + i });
    }
    const page1 = store.list({ limit: 3, offset: 0 });
    expect(page1.users).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.limit).toBe(3);
    expect(page1.offset).toBe(0);

    const page2 = store.list({ limit: 3, offset: 3 });
    expect(page2.users).toHaveLength(3);
    expect(page2.users[0].id).not.toBe(page1.users[0].id);
  });

  it("caps limit at 100", () => {
    for (let i = 0; i < 5; i++) {
      insertUser(db, { id: `user-${i}` });
    }
    const result = store.list({ limit: 999 });
    expect(result.limit).toBe(100);
  });

  it("filters by status", () => {
    insertUser(db, { id: "active-1", status: "active" });
    insertUser(db, { id: "suspended-1", status: "suspended" });
    insertUser(db, { id: "dormant-1", status: "dormant" });

    const result = store.list({ status: "suspended" });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("suspended-1");
    expect(result.total).toBe(1);
  });

  it("filters by role", () => {
    insertUser(db, { id: "admin-1", role: "platform_admin" });
    insertUser(db, { id: "user-1", role: "user" });
    insertUser(db, { id: "tenant-admin-1", role: "tenant_admin" });

    const result = store.list({ role: "platform_admin" });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("admin-1");
  });

  it("filters by hasCredits", () => {
    insertUser(db, { id: "rich", credit_balance_cents: 5000 });
    insertUser(db, { id: "broke", credit_balance_cents: 0 });

    const result = store.list({ hasCredits: true });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("rich");
  });

  it("filters by lowBalance", () => {
    insertUser(db, { id: "low", credit_balance_cents: 200 });
    insertUser(db, { id: "high", credit_balance_cents: 5000 });
    insertUser(db, { id: "zero", credit_balance_cents: 0 });

    const result = store.list({ lowBalance: true });
    expect(result.users).toHaveLength(2);
    const ids = result.users.map((u) => u.id);
    expect(ids).toContain("low");
    expect(ids).toContain("zero");
  });

  it("searches across name, email, and tenant_id", () => {
    insertUser(db, { id: "u1", name: "Alice Smith", email: "alice@example.com", tenant_id: "acme" });
    insertUser(db, { id: "u2", name: "Bob Jones", email: "bob@example.com", tenant_id: "globex" });
    insertUser(db, { id: "u3", name: "Charlie", email: "charlie@acme.io", tenant_id: "other" });

    const result = store.list({ search: "acme" });
    expect(result.users).toHaveLength(2);
    const ids = result.users.map((u) => u.id);
    expect(ids).toContain("u1"); // tenant_id match
    expect(ids).toContain("u3"); // email match
  });

  it("search is case-insensitive (via LIKE)", () => {
    insertUser(db, { id: "u1", name: "Alice Smith" });
    const result = store.list({ search: "alice" });
    expect(result.users).toHaveLength(1);
  });

  it("search escapes LIKE wildcards", () => {
    insertUser(db, { id: "u1", name: "100% complete" });
    insertUser(db, { id: "u2", name: "not a match" });

    const result = store.list({ search: "100%" });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("u1");
  });

  it("sorts by created_at descending by default", () => {
    insertUser(db, { id: "old", created_at: 1000 });
    insertUser(db, { id: "new", created_at: 2000 });

    const result = store.list();
    expect(result.users[0].id).toBe("new");
    expect(result.users[1].id).toBe("old");
  });

  it("sorts by created_at ascending", () => {
    insertUser(db, { id: "old", created_at: 1000 });
    insertUser(db, { id: "new", created_at: 2000 });

    const result = store.list({ sortBy: "created_at", sortOrder: "asc" });
    expect(result.users[0].id).toBe("old");
    expect(result.users[1].id).toBe("new");
  });

  it("sorts by balance", () => {
    insertUser(db, { id: "low", credit_balance_cents: 100, created_at: 1000 });
    insertUser(db, { id: "high", credit_balance_cents: 5000, created_at: 2000 });

    const result = store.list({ sortBy: "balance", sortOrder: "desc" });
    expect(result.users[0].id).toBe("high");
    expect(result.users[1].id).toBe("low");
  });

  it("sorts by agent_count", () => {
    insertUser(db, { id: "few", agent_count: 1, created_at: 1000 });
    insertUser(db, { id: "many", agent_count: 10, created_at: 2000 });

    const result = store.list({ sortBy: "agent_count", sortOrder: "desc" });
    expect(result.users[0].id).toBe("many");
    expect(result.users[1].id).toBe("few");
  });

  it("sorts by last_seen", () => {
    insertUser(db, { id: "recent", last_seen: 2000, created_at: 1000 });
    insertUser(db, { id: "stale", last_seen: 1000, created_at: 2000 });

    const result = store.list({ sortBy: "last_seen", sortOrder: "desc" });
    expect(result.users[0].id).toBe("recent");
    expect(result.users[1].id).toBe("stale");
  });

  it("combines multiple filters", () => {
    insertUser(db, { id: "match", status: "active", role: "user", credit_balance_cents: 5000 });
    insertUser(db, { id: "wrong-status", status: "suspended", role: "user", credit_balance_cents: 5000 });
    insertUser(db, { id: "wrong-role", status: "active", role: "platform_admin", credit_balance_cents: 5000 });
    insertUser(db, { id: "no-credits", status: "active", role: "user", credit_balance_cents: 0 });

    const result = store.list({ status: "active", role: "user", hasCredits: true });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].id).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// AdminUserStore.search
// ---------------------------------------------------------------------------

describe("AdminUserStore.search", () => {
  let db: BetterSqlite3.Database;
  let store: AdminUserStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AdminUserStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("searches by name", () => {
    insertUser(db, { id: "u1", name: "Alice Smith" });
    insertUser(db, { id: "u2", name: "Bob Jones" });

    const results = store.search("Alice");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("u1");
  });

  it("searches by email", () => {
    insertUser(db, { id: "u1", email: "alice@example.com" });
    insertUser(db, { id: "u2", email: "bob@other.com" });

    const results = store.search("example.com");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("u1");
  });

  it("searches by tenant_id", () => {
    insertUser(db, { id: "u1", tenant_id: "acme-corp" });
    insertUser(db, { id: "u2", tenant_id: "globex" });

    const results = store.search("acme");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("u1");
  });

  it("returns empty array when no matches", () => {
    insertUser(db, { id: "u1", name: "Alice" });
    const results = store.search("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("limits results to 50", () => {
    for (let i = 0; i < 60; i++) {
      insertUser(db, { id: `user-${i}`, name: "Searchable Name" });
    }
    const results = store.search("Searchable");
    expect(results).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// AdminUserStore.getById
// ---------------------------------------------------------------------------

describe("AdminUserStore.getById", () => {
  let db: BetterSqlite3.Database;
  let store: AdminUserStore;

  beforeEach(() => {
    db = createTestDb();
    store = new AdminUserStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns user by ID", () => {
    insertUser(db, {
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      tenant_id: "acme",
      status: "active",
      role: "user",
      credit_balance_cents: 1500,
      agent_count: 3,
      last_seen: 1700000000000,
      created_at: 1600000000000,
    });

    const user = store.getById("user-1");
    expect(user).not.toBeNull();
    expect(user?.id).toBe("user-1");
    expect(user?.email).toBe("alice@example.com");
    expect(user?.name).toBe("Alice");
    expect(user?.tenant_id).toBe("acme");
    expect(user?.status).toBe("active");
    expect(user?.role).toBe("user");
    expect(user?.credit_balance_cents).toBe(1500);
    expect(user?.agent_count).toBe(3);
    expect(user?.last_seen).toBe(1700000000000);
    expect(user?.created_at).toBe(1600000000000);
  });

  it("returns null for nonexistent user", () => {
    const user = store.getById("nonexistent");
    expect(user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API Route tests
// ---------------------------------------------------------------------------

describe("admin users API routes", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET / returns paginated user list", async () => {
    for (let i = 0; i < 5; i++) {
      insertUser(db, { id: `user-${i}` });
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
    insertUser(db, { id: "u1", name: "Alice Smith" });
    insertUser(db, { id: "u2", name: "Bob Jones" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?search=Alice");
    const body = (await res.json()) as { users: { id: string }[]; total: number };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("u1");
  });

  it("GET / supports status filter", async () => {
    insertUser(db, { id: "active-1", status: "active" });
    insertUser(db, { id: "suspended-1", status: "suspended" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?status=suspended");
    const body = (await res.json()) as { users: { id: string }[]; total: number };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("suspended-1");
  });

  it("GET / supports role filter", async () => {
    insertUser(db, { id: "admin-1", role: "platform_admin" });
    insertUser(db, { id: "user-1", role: "user" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?role=platform_admin");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("admin-1");
  });

  it("GET / supports hasCredits filter", async () => {
    insertUser(db, { id: "rich", credit_balance_cents: 5000 });
    insertUser(db, { id: "broke", credit_balance_cents: 0 });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?hasCredits=true");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("rich");
  });

  it("GET / supports sorting", async () => {
    insertUser(db, { id: "old", created_at: 1000 });
    insertUser(db, { id: "new", created_at: 2000 });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?sortBy=created_at&sortOrder=asc");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users[0].id).toBe("old");
    expect(body.users[1].id).toBe("new");
  });

  it("GET / supports pagination", async () => {
    for (let i = 0; i < 10; i++) {
      insertUser(db, { id: `user-${i}` });
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
    insertUser(db, { id: "u1", status: "active" });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?status=invalid");
    const body = (await res.json()) as { users: unknown[] };
    // Invalid status is ignored, returns all users
    expect(body.users).toHaveLength(1);
  });

  it("GET /:userId returns single user", async () => {
    insertUser(db, { id: "user-42", email: "alice@example.com", name: "Alice" });

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
    insertUser(db, { id: "low", credit_balance_cents: 200 });
    insertUser(db, { id: "high", credit_balance_cents: 5000 });

    const app = new Hono();
    app.route("/admin/users", createAdminUsersApiRoutes(db));

    const res = await app.request("/admin/users?lowBalance=true");
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe("low");
  });
});
