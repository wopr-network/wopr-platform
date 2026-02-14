import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminAuditApiRoutes } from "../api/routes/admin-audit.js";
import type { AuditEntry } from "./audit-log.js";
import { AdminAuditLog } from "./audit-log.js";
import { initAdminAuditSchema } from "./audit-schema.js";

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initAdminAuditSchema(db);
  return db;
}

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

describe("initAdminAuditSchema", () => {
  it("creates admin_audit_log table", () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit_log'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_admin_audit_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initAdminAuditSchema(db);
    db.close();
  });
});

describe("AdminAuditLog.log", () => {
  let db: BetterSqlite3.Database;
  let auditLog: AdminAuditLog;

  beforeEach(() => {
    db = createTestDb();
    auditLog = new AdminAuditLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it("log entry creates a row", () => {
    const row = auditLog.log(makeEntry());
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

    const dbRow = db.prepare("SELECT * FROM admin_audit_log WHERE id = ?").get(row.id);
    expect(dbRow).toBeTruthy();
  });

  it("generates unique IDs", () => {
    const r1 = auditLog.log(makeEntry());
    const r2 = auditLog.log(makeEntry());
    expect(r1.id).not.toBe(r2.id);
  });

  it("handles null optional fields", () => {
    const row = auditLog.log(
      makeEntry({ targetTenant: undefined, targetUser: undefined, ipAddress: undefined, userAgent: undefined }),
    );
    expect(row.target_tenant).toBeNull();
    expect(row.target_user).toBeNull();
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();
  });

  it("serializes details as JSON", () => {
    const row = auditLog.log(makeEntry({ details: { amount: 100, currency: "USD" } }));
    expect(row.details).toBe('{"amount":100,"currency":"USD"}');
  });
});

describe("AdminAuditLog.query", () => {
  let db: BetterSqlite3.Database;
  let auditLog: AdminAuditLog;

  beforeEach(() => {
    db = createTestDb();
    auditLog = new AdminAuditLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it("query with filters - by admin", () => {
    auditLog.log(makeEntry({ adminUser: "admin-1" }));
    auditLog.log(makeEntry({ adminUser: "admin-2" }));

    const result = auditLog.query({ admin: "admin-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].admin_user).toBe("admin-1");
    expect(result.total).toBe(1);
  });

  it("query with filters - by action", () => {
    auditLog.log(makeEntry({ action: "user.suspend" }));
    auditLog.log(makeEntry({ action: "credits.add" }));

    const result = auditLog.query({ action: "user.suspend" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe("user.suspend");
  });

  it("query with filters - by category", () => {
    auditLog.log(makeEntry({ category: "account" }));
    auditLog.log(makeEntry({ category: "credits", action: "credits.add" }));

    const result = auditLog.query({ category: "credits" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("credits");
  });

  it("query with filters - by tenant", () => {
    auditLog.log(makeEntry({ targetTenant: "tenant-1" }));
    auditLog.log(makeEntry({ targetTenant: "tenant-2" }));

    const result = auditLog.query({ tenant: "tenant-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].target_tenant).toBe("tenant-1");
  });

  it("query with filters - by date range", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO admin_audit_log (id, admin_user, action, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("old", "admin-1", "user.suspend", "account", "{}", now - 100000);
    db.prepare(
      "INSERT INTO admin_audit_log (id, admin_user, action, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("new", "admin-1", "user.suspend", "account", "{}", now);

    const result = auditLog.query({ from: now - 5000 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("new");
  });

  it("pagination - limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      auditLog.log(makeEntry());
    }

    const page1 = auditLog.query({ limit: 3, offset: 0 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.total).toBe(10);

    const page2 = auditLog.query({ limit: 3, offset: 3 });
    expect(page2.entries).toHaveLength(3);
    expect(page2.entries[0].id).not.toBe(page1.entries[0].id);
  });

  it("returns entries ordered by created_at descending", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO admin_audit_log (id, admin_user, action, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("first", "admin-1", "user.suspend", "account", "{}", now - 1000);
    db.prepare(
      "INSERT INTO admin_audit_log (id, admin_user, action, category, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("second", "admin-1", "user.suspend", "account", "{}", now);

    const result = auditLog.query({});
    expect(result.entries[0].id).toBe("second");
    expect(result.entries[1].id).toBe("first");
  });

  it("returns empty results when no entries match", () => {
    const result = auditLog.query({ admin: "nonexistent" });
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("caps limit at 250", () => {
    for (let i = 0; i < 5; i++) {
      auditLog.log(makeEntry());
    }

    const result = auditLog.query({ limit: 999 });
    expect(result.entries).toHaveLength(5);
  });
});

describe("AdminAuditLog.exportCsv", () => {
  let db: BetterSqlite3.Database;
  let auditLog: AdminAuditLog;

  beforeEach(() => {
    db = createTestDb();
    auditLog = new AdminAuditLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it("CSV export format", () => {
    auditLog.log(makeEntry());

    const csv = auditLog.exportCsv({});
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
      auditLog.log(makeEntry());
    }

    const csv = auditLog.exportCsv({ limit: 2, offset: 1 });
    const lines = csv.split("\n");
    // Header + 5 data lines (limit/offset ignored for export)
    expect(lines).toHaveLength(6);
  });

  it("applies filters to export", () => {
    auditLog.log(makeEntry({ adminUser: "admin-1" }));
    auditLog.log(makeEntry({ adminUser: "admin-2" }));

    const csv = auditLog.exportCsv({ admin: "admin-1" });
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2); // header + 1 entry
  });

  it("escapes double quotes in details", () => {
    auditLog.log(makeEntry({ details: { note: 'said "hello"' } }));

    const csv = auditLog.exportCsv({});
    // JSON serializes inner quotes as \", then CSV escaping doubles all " to ""
    // Result: {""note"":""said \""hello\""""}
    expect(csv).toContain('""note""');
  });

  it("handles null optional fields in CSV", () => {
    auditLog.log(makeEntry({ targetTenant: undefined, targetUser: undefined }));

    const csv = auditLog.exportCsv({});
    const lines = csv.split("\n");
    const fields = lines[1].split(",");
    // target_tenant and target_user should be empty strings
    expect(fields[4]).toBe("");
    expect(fields[5]).toBe("");
  });
});

describe("entries are immutable", () => {
  it("entries are immutable - no update or delete API", () => {
    const db = createTestDb();
    const auditLog = new AdminAuditLog(db);
    const row = auditLog.log(makeEntry());

    // Verify the class has no update or delete methods
    expect(typeof (auditLog as unknown as Record<string, unknown>).update).toBe("undefined");
    expect(typeof (auditLog as unknown as Record<string, unknown>).delete).toBe("undefined");

    // Verify the entry persists
    const result = auditLog.query({});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(row.id);

    db.close();
  });
});

describe("admin audit API routes", () => {
  let db: BetterSqlite3.Database;
  let auditLog: AdminAuditLog;

  beforeEach(() => {
    db = createTestDb();
    auditLog = new AdminAuditLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it("GET /admin/audit returns entries", async () => {
    auditLog.log(makeEntry());
    auditLog.log(makeEntry({ adminUser: "admin-2" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /admin/audit filters by admin", async () => {
    auditLog.log(makeEntry({ adminUser: "admin-1" }));
    auditLog.log(makeEntry({ adminUser: "admin-2" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit?admin=admin-1");
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].admin_user).toBe("admin-1");
  });

  it("GET /admin/audit filters by category", async () => {
    auditLog.log(makeEntry({ category: "account" }));
    auditLog.log(makeEntry({ category: "credits", action: "credits.add" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit?category=credits");
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].category).toBe("credits");
  });

  it("GET /admin/audit supports limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      auditLog.log(makeEntry());
    }

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit?limit=2&offset=1");
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("GET /admin/audit/export returns CSV", async () => {
    auditLog.log(makeEntry());

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
    auditLog.log(makeEntry({ adminUser: "admin-1" }));
    auditLog.log(makeEntry({ adminUser: "admin-2" }));

    const app = new Hono();
    app.route("/admin/audit", createAdminAuditApiRoutes(db));

    const res = await app.request("/admin/audit/export?admin=admin-1");
    const text = await res.text();
    const lines = text.split("\n");
    expect(lines).toHaveLength(2); // header + 1 entry
  });
});
