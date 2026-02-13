import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminAuditRoutes, createAuditRoutes } from "../api/routes/audit.js";
import { AuditLogger } from "./logger.js";
import { auditLog, extractResourceType } from "./middleware.js";
import { countAuditLog, queryAuditLog } from "./query.js";
import { getRetentionDays, purgeExpiredEntries, purgeExpiredEntriesForUser } from "./retention.js";
import type { AuditEntryInput } from "./schema.js";
import { initAuditSchema } from "./schema.js";
import type { AuditEnv } from "./types.js";

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initAuditSchema(db);
  return db;
}

function makeInput(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    userId: "user-1",
    authMethod: "session",
    action: "instance.create",
    resourceType: "instance",
    resourceId: "inst-abc",
    ipAddress: "127.0.0.1",
    userAgent: "test-agent",
    ...overrides,
  };
}

describe("initAuditSchema", () => {
  it("creates audit_log table", () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_audit_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initAuditSchema(db);
    db.close();
  });
});

describe("AuditLogger", () => {
  let db: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts audit entries", () => {
    const entry = logger.log(makeInput());
    expect(entry.id).toBeTruthy();
    expect(entry.user_id).toBe("user-1");
    expect(entry.action).toBe("instance.create");
    expect(entry.resource_type).toBe("instance");
    expect(entry.resource_id).toBe("inst-abc");
    expect(entry.ip_address).toBe("127.0.0.1");
    expect(entry.user_agent).toBe("test-agent");
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("serializes details as JSON", () => {
    const entry = logger.log(makeInput({ details: { foo: "bar", count: 42 } }));
    expect(entry.details).toBe('{"foo":"bar","count":42}');
  });

  it("handles null optional fields", () => {
    const entry = logger.log(makeInput({ resourceId: null, details: null, ipAddress: null, userAgent: null }));
    expect(entry.resource_id).toBeNull();
    expect(entry.details).toBeNull();
    expect(entry.ip_address).toBeNull();
    expect(entry.user_agent).toBeNull();
  });

  it("generates unique IDs", () => {
    const e1 = logger.log(makeInput());
    const e2 = logger.log(makeInput());
    expect(e1.id).not.toBe(e2.id);
  });
});

describe("queryAuditLog", () => {
  let db: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns all entries without filters", () => {
    logger.log(makeInput());
    logger.log(makeInput({ action: "instance.destroy" }));

    const results = queryAuditLog(db, {});
    expect(results).toHaveLength(2);
  });

  it("filters by userId", () => {
    logger.log(makeInput({ userId: "user-1" }));
    logger.log(makeInput({ userId: "user-2" }));

    const results = queryAuditLog(db, { userId: "user-1" });
    expect(results).toHaveLength(1);
    expect(results[0].user_id).toBe("user-1");
  });

  it("filters by exact action", () => {
    logger.log(makeInput({ action: "instance.create" }));
    logger.log(makeInput({ action: "instance.destroy" }));
    logger.log(makeInput({ action: "plugin.install", resourceType: "plugin" }));

    const results = queryAuditLog(db, { action: "instance.create" });
    expect(results).toHaveLength(1);
  });

  it("filters by wildcard action", () => {
    logger.log(makeInput({ action: "instance.create" }));
    logger.log(makeInput({ action: "instance.destroy" }));
    logger.log(makeInput({ action: "plugin.install", resourceType: "plugin" }));

    const results = queryAuditLog(db, { action: "instance.*" });
    expect(results).toHaveLength(2);
  });

  it("filters by resourceType", () => {
    logger.log(makeInput({ resourceType: "instance" }));
    logger.log(makeInput({ resourceType: "plugin", action: "plugin.install" }));

    const results = queryAuditLog(db, { resourceType: "instance" });
    expect(results).toHaveLength(1);
  });

  it("filters by resourceId", () => {
    logger.log(makeInput({ resourceId: "inst-1" }));
    logger.log(makeInput({ resourceId: "inst-2" }));

    const results = queryAuditLog(db, { resourceId: "inst-1" });
    expect(results).toHaveLength(1);
  });

  it("filters by time range", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("old", now - 10000, "user-1", "session", "instance.create", "instance");
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("new", now, "user-1", "session", "instance.destroy", "instance");

    const results = queryAuditLog(db, { since: now - 5000 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("new");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      logger.log(makeInput());
    }

    const results = queryAuditLog(db, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("respects offset", () => {
    for (let i = 0; i < 5; i++) {
      logger.log(makeInput());
    }

    const all = queryAuditLog(db, {});
    const offset = queryAuditLog(db, { offset: 2 });
    expect(offset).toHaveLength(3);
    expect(offset[0].id).toBe(all[2].id);
  });

  it("orders by timestamp descending", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("first", now - 1000, "user-1", "session", "instance.create", "instance");
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("second", now, "user-1", "session", "instance.destroy", "instance");

    const results = queryAuditLog(db, {});
    expect(results[0].id).toBe("second");
    expect(results[1].id).toBe("first");
  });

  it("caps limit at 250", () => {
    for (let i = 0; i < 5; i++) {
      logger.log(makeInput());
    }

    const results = queryAuditLog(db, { limit: 999 });
    expect(results).toHaveLength(5);
  });
});

describe("countAuditLog", () => {
  let db: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    db.close();
  });

  it("counts all entries", () => {
    logger.log(makeInput());
    logger.log(makeInput());
    expect(countAuditLog(db, {})).toBe(2);
  });

  it("counts with filters", () => {
    logger.log(makeInput({ userId: "user-1" }));
    logger.log(makeInput({ userId: "user-2" }));
    expect(countAuditLog(db, { userId: "user-1" })).toBe(1);
  });
});

describe("retention", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns correct retention days per tier", () => {
    expect(getRetentionDays("free")).toBe(7);
    expect(getRetentionDays("pro")).toBe(30);
    expect(getRetentionDays("team")).toBe(90);
    expect(getRetentionDays("enterprise")).toBe(365);
  });

  it("purges entries older than retention period", () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;

    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("old", eightDaysAgo, "user-1", "session", "instance.create", "instance");
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("recent", oneDayAgo, "user-1", "session", "instance.destroy", "instance");

    const deleted = purgeExpiredEntries(db, "free");
    expect(deleted).toBe(1);

    const remaining = db.prepare("SELECT id FROM audit_log").all() as { id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("recent");
  });

  it("does not purge recent entries", () => {
    const logger = new AuditLogger(db);
    logger.log(makeInput());

    const deleted = purgeExpiredEntries(db, "free");
    expect(deleted).toBe(0);
  });

  it("purges per user for user-scoped retention", () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("u1-old", eightDaysAgo, "user-1", "session", "instance.create", "instance");
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("u2-old", eightDaysAgo, "user-2", "session", "instance.create", "instance");

    const deleted = purgeExpiredEntriesForUser(db, "user-1", "free");
    expect(deleted).toBe(1);

    const remaining = db.prepare("SELECT id FROM audit_log").all() as { id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("u2-old");
  });

  it("pro tier retains entries for 30 days", () => {
    const now = Date.now();
    const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;

    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("within-pro", twentyDaysAgo, "user-1", "session", "instance.create", "instance");

    const deleted = purgeExpiredEntries(db, "pro");
    expect(deleted).toBe(0);
  });
});

describe("extractResourceType", () => {
  it("extracts instance from path", () => {
    expect(extractResourceType("/api/instance/abc")).toBe("instance");
  });

  it("extracts plugin from path", () => {
    expect(extractResourceType("/api/plugin/xyz")).toBe("plugin");
  });

  it("extracts api_key from path", () => {
    expect(extractResourceType("/api/key/k-1")).toBe("api_key");
  });

  it("extracts user from auth path", () => {
    expect(extractResourceType("/api/auth/login")).toBe("user");
  });

  it("extracts config from path", () => {
    expect(extractResourceType("/api/config/settings")).toBe("config");
  });

  it("extracts tier from path", () => {
    expect(extractResourceType("/api/tier/upgrade")).toBe("tier");
  });

  it("defaults to instance for unknown path", () => {
    expect(extractResourceType("/api/unknown")).toBe("instance");
  });
});

describe("auditLog middleware", () => {
  let db: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    db.close();
  });

  it("logs entry on successful response", async () => {
    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLog(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    await app.request("/instance/inst-1", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.1", "user-agent": "TestClient/1.0" },
    });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(1);
    expect(entries[0].user_id).toBe("user-1");
    expect(entries[0].action).toBe("instance.create");
    expect(entries[0].resource_id).toBe("inst-1");
    expect(entries[0].ip_address).toBe("10.0.0.1");
    expect(entries[0].user_agent).toBe("TestClient/1.0");
  });

  it("does not log on error response", async () => {
    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLog(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ error: "bad" }, 400));

    await app.request("/instance/inst-1", { method: "POST" });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(0);
  });

  it("is a no-op without user context", async () => {
    const app = new Hono();
    app.use("/instance/:id", auditLog(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    await app.request("/instance/inst-1", { method: "POST" });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(0);
  });

  it("does not break the request on logging error", async () => {
    const badDb = new BetterSqlite3(":memory:");
    initAuditSchema(badDb);
    const badLogger = new AuditLogger(badDb);
    badDb.close();

    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLog(badLogger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    const res = await app.request("/instance/inst-1", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("audit API routes", () => {
  let db: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /audit (user route)", () => {
    it("returns user's own entries", async () => {
      logger.log(makeInput({ userId: "user-1" }));
      logger.log(makeInput({ userId: "user-2" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1", tier: "pro" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].user_id).toBe("user-1");
      expect(body.total).toBe(1);
    });

    it("filters by action query param", async () => {
      logger.log(makeInput({ userId: "user-1", action: "instance.create" }));
      logger.log(makeInput({ userId: "user-1", action: "plugin.install", resourceType: "plugin" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit?action=instance.*");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].action).toBe("instance.create");
    });

    it("applies retention cleanup on query", async () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      db.prepare(
        "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("old-entry", eightDaysAgo, "user-1", "session", "instance.create", "instance");
      logger.log(makeInput({ userId: "user-1" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1", tier: "free" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].id).not.toBe("old-entry");
    });
  });

  describe("GET /admin/audit (admin route)", () => {
    it("returns 403 for non-admin", async () => {
      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1", isAdmin: false });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit");
      expect(res.status).toBe(403);
    });

    it("returns all entries for admin", async () => {
      logger.log(makeInput({ userId: "user-1" }));
      logger.log(makeInput({ userId: "user-2" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", isAdmin: true });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit");
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("filters by userId", async () => {
      logger.log(makeInput({ userId: "user-1" }));
      logger.log(makeInput({ userId: "user-2" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", isAdmin: true });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit?userId=user-2");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].user_id).toBe("user-2");
    });

    it("filters by time range", async () => {
      const now = Date.now();
      db.prepare(
        "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("old", now - 100000, "user-1", "session", "instance.create", "instance");
      logger.log(makeInput({ userId: "user-1" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", isAdmin: true });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request(`/admin/audit?since=${now - 5000}`);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].id).not.toBe("old");
    });
  });
});
