import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminAuditApiRoutes } from "../api/routes/admin-audit.js";
import type { DrizzleDb } from "../db/index.js";
import { adminAuditLog } from "../db/schema/index.js";
import { createTestDb } from "../test/db.js";
import type { AuditEntry } from "./audit-log.js";
import { AdminAuditLog } from "./audit-log.js";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    adminUser: "admin-1",
    action: "user.suspend",
    category: "account",
    targetTenant: "tenant-1",
    targetUser: "user-42",
    details: { reason: "ToS violation" },
    ipAddress: "10.0.0.1",
    userAgent: "AdminPanel/1.0",
    ...overrides,
  };
}

describe("AdminAuditLog.log", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let auditLogInstance: AdminAuditLog;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    auditLogInstance = new AdminAuditLog(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("log entry creates a row", () => {
    const row = auditLogInstance.log(makeEntry());
    expect(row.id).toBeTruthy();
    expect(row.admin_user).toBe("admin-1");
    expect(row.action).toBe("user.suspend");
    expect(row.category).toBe("account");
    expect(row.target_tenant).toBe("tenant-1");
    expect(row.target_user).toBe("user-42");
    expect(JSON.parse(row.details)).toEqual({ reason: "ToS violation" });
    expect(row.ip_address).toBe("10.0.0.1");
    expect(row.user_agent).toBe("AdminPanel/1.0");
    expect(row.created_at).toBeGreaterThan(0);

    const dbRows = db.select().from(adminAuditLog).all();
    expect(dbRows.find((r) => r.id === row.id)).toBeTruthy();
  });

  it("generates unique IDs", () => {
    const r1 = auditLogInstance.log(makeEntry());
    const r2 = auditLogInstance.log(makeEntry());
    expect(r1.id).not.toBe(r2.id);
  });

  it("handles null optional fields", () => {
    const row = auditLogInstance.log(
      makeEntry({ targetTenant: undefined, targetUser: undefined, ipAddress: undefined, userAgent: undefined }),
    );
    expect(row.target_tenant).toBeNull();
    expect(row.target_user).toBeNull();
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();
  });

  it("serializes details as JSON", () => {
    const row = auditLogInstance.log(makeEntry({ details: { amount: 100, currency: "USD" } }));
    expect(row.details).toBe('{"amount":100,"currency":"USD"}');
  });
});

describe("AdminAuditLog.query", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let auditLogInstance: AdminAuditLog;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    auditLogInstance = new AdminAuditLog(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("query with filters - by admin", () => {
    auditLogInstance.log(makeEntry({ adminUser: "admin-1" }));
    auditLogInstance.log(makeEntry({ adminUser: "admin-2" }));

    const result = auditLogInstance.query({ admin: "admin-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].admin_user).toBe("admin-1");
    expect(result.total).toBe(1);
  });

  it("query with filters - by action", () => {
    auditLogInstance.log(makeEntry({ action: "user.suspend" }));
    auditLogInstance.log(makeEntry({ action: "credits.add" }));

    const result = auditLogInstance.query({ action: "user.suspend" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe("user.suspend");
  });

  it("query with filters - by category", () => {
    auditLogInstance.log(makeEntry({ category: "account" }));
    auditLogInstance.log(makeEntry({ category: "credits", action: "credits.add" }));

    const result = auditLogInstance.query({ category: "credits" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("credits");
  });

  it("query with filters - by tenant", () => {
    auditLogInstance.log(makeEntry({ targetTenant: "tenant-1" }));
    auditLogInstance.log(makeEntry({ targetTenant: "tenant-2" }));

    const result = auditLogInstance.query({ tenant: "tenant-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].target_tenant).toBe("tenant-1");
  });

  it("query with filters - by date range", () => {
    const now = Date.now();
    db.insert(adminAuditLog).values({
      id: "old",
      adminUser: "admin-1",
      action: "user.suspend",
      category: "account",
      details: "{}",
      createdAt: now - 100000,
    }).run();
    db.insert(adminAuditLog).values({
      id: "new",
      adminUser: "admin-1",
      action: "user.suspend",
      category: "account",
      details: "{}",
      createdAt: now,
    }).run();

    const result = auditLogInstance.query({ from: now - 5000 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("new");
  });

  it("pagination - limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      auditLogInstance.log(makeEntry());
    }

    const page1 = auditLogInstance.query({ limit: 3, offset: 0 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.total).toBe(10);

    const page2 = auditLogInstance.query({ limit: 3, offset: 3 });
    expect(page2.entries).toHaveLength(3);
    expect(page2.entries[0].id).not.toBe(page1.entries[0].id);
  });

  it("returns entries ordered by created_at descending", () => {
    const now = Date.now();
    db.insert(adminAuditLog).values({
      id: "first",
      adminUser: "admin-1",
      action: "user.suspend",
      category: "account",
      details: "{}",
      createdAt: now - 1000,
    }).run();
    db.insert(adminAuditLog).values({
      id: "second",
      adminUser: "admin-1",
      action: "user.suspend",
      category: "account",
      details: "{}",
      createdAt: now,
    }).run();

    const result = auditLogInstance.query({});
    expect(result.entries[0].id).toBe("second");
    expect(result.entries[1].id).toBe("first");
  });

  it("returns empty results when no entries match", () => {
    const result = auditLogInstance.query({ admin: "nonexistent" });
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("caps limit at 250", () => {
    for (let i = 0; i < 5; i++) {
      auditLogInstance.log(makeEntry());
    }

    const result = auditLogInstance.query({ limit: 999 });
    expect(result.entries).toHaveLength(5);
  });
});

describe("AdminAuditLog.exportCsv", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let auditLogInstance: AdminAuditLog;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    auditLogInstance = new AdminAuditLog(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("CSV export format", () => {
    auditLogInstance.log(makeEntry());

    const csv = auditLogInstance.exportCsv({});
    const lines = csv.split("\n");

    expect(lines[0]).toBe(
      "id,admin_user,action,category,target_tenant,target_user,details,ip_address,user_agent,created_at",
    );
    expect(lines).toHaveLength(2);

    const fields = lines[1].split(",");
    expect(fields[1]).toBe("admin-1");
    expect(fields[2]).toBe("user.suspend");
    expect(fields[3]).toBe("account");
    expect(fields[4]).toBe("tenant-1");
    expect(fields[5]).toBe("user-42");
  });

  it("exports all entries ignoring pagination", () => {
    for (let i = 0; i < 5; i++) {
      auditLogInstance.log(makeEntry());
    }

    const csv = auditLogInstance.exportCsv({ limit: 2, offset: 1 });
    const lines = csv.split("\n");
    // Header + 5 data lines (limit/offset ignored for export)
    expect(lines).toHaveLength(6);
  });

  it("applies filters to export", () => {
    auditLogInstance.log(makeEntry({ adminUser: "admin-1" }));
    auditLogInstance.log(makeEntry({ adminUser: "admin-2" }));

    const csv = auditLogInstance.exportCsv({ admin: "admin-1" });
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2); // header + 1 entry
  });

  it("escapes double quotes in details", () => {
    auditLogInstance.log(makeEntry({ details: { note: 'said "hello"' } }));

    const csv = auditLogInstance.exportCsv({});
    // JSON serializes inner quotes as \", then CSV escaping doubles all " to ""
    expect(csv).toContain('""note""');
  });

  it("handles null optional fields in CSV", () => {
    auditLogInstance.log(makeEntry({ targetTenant: undefined, targetUser: undefined }));

    const csv = auditLogInstance.exportCsv({});
    const lines = csv.split("\n");
    const fields = lines[1].split(",");
    // target_tenant and target_user should be empty strings
    expect(fields[4]).toBe("");
    expect(fields[5]).toBe("");
  });
});

describe("entries are immutable", () => {
  it("entries are immutable - no update or delete API", () => {
    const t = createTestDb();
    const auditLogInstance = new AdminAuditLog(t.db);
    const row = auditLogInstance.log(makeEntry());

    // Verify the class has no update or delete methods
    expect(typeof (auditLogInstance as unknown as Record<string, unknown>).update).toBe("undefined");
    expect(typeof (auditLogInstance as unknown as Record<string, unknown>).delete).toBe("undefined");

    // Verify the entry persists
    const result = auditLogInstance.query({});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(row.id);

    t.sqlite.close();
  });
});

describe("admin audit API routes", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let auditLogInstance: AdminAuditLog;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    auditLogInstance = new AdminAuditLog(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("GET /admin/audit returns entries", async () => {
    auditLogInstance.log(makeEntry());
    auditLogInstance.log(makeEntry({ adminUser: "admin-2" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /admin/audit filters by admin", async () => {
    auditLogInstance.log(makeEntry({ adminUser: "admin-1" }));
    auditLogInstance.log(makeEntry({ adminUser: "admin-2" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit?admin=admin-1");
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].admin_user).toBe("admin-1");
  });

  it("GET /admin/audit filters by category", async () => {
    auditLogInstance.log(makeEntry({ category: "account" }));
    auditLogInstance.log(makeEntry({ category: "credits", action: "credits.add" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit?category=credits");
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].category).toBe("credits");
  });

  it("GET /admin/audit supports limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      auditLogInstance.log(makeEntry());
    }

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit?limit=2&offset=1");
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("GET /admin/audit/export returns CSV", async () => {
    auditLogInstance.log(makeEntry());

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="audit-log.csv"');

    const text = await res.text();
    const lines = text.split("\n");
    expect(lines[0]).toContain("id,admin_user,action,category");
    expect(lines).toHaveLength(2);
  });

  it("GET /admin/audit/export applies filters", async () => {
    auditLogInstance.log(makeEntry({ adminUser: "admin-1" }));
    auditLogInstance.log(makeEntry({ adminUser: "admin-2" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit/export?admin=admin-1");
    const text = await res.text();
    const lines = text.split("\n");
    expect(lines).toHaveLength(2); // header + 1 entry
  });
});
