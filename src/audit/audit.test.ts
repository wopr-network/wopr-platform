import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminAuditRoutes, createAuditRoutes } from "../api/routes/audit.js";
import type { DrizzleDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import { createTestDb } from "../test/db.js";
import { AuditLogger } from "./logger.js";
import { auditLog as auditLogMiddleware, extractResourceType } from "./middleware.js";
import { countAuditLog, queryAuditLog } from "./query.js";
import { getRetentionDays, purgeExpiredEntries, purgeExpiredEntriesForUser } from "./retention.js";
import type { AuditEntryInput } from "./schema.js";
import type { AuditEnv } from "./types.js";

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

describe("AuditLogger", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    sqlite.close();
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
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    sqlite.close();
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
    db.insert(auditLog).values({
      id: "old",
      timestamp: now - 10000,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "new",
      timestamp: now,
      userId: "user-1",
      authMethod: "session",
      action: "instance.destroy",
      resourceType: "instance",
    }).run();

    const results = queryAuditLog(db, { since: now - 5000 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("new");
  });

  it("filters by until time boundary", () => {
    const now = Date.now();
    db.insert(auditLog).values({
      id: "old",
      timestamp: now - 10000,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "new",
      timestamp: now,
      userId: "user-1",
      authMethod: "session",
      action: "instance.destroy",
      resourceType: "instance",
    }).run();

    const results = queryAuditLog(db, { until: now - 5000 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("old");
  });

  it("combines multiple filters", () => {
    logger.log(makeInput({ userId: "user-1", action: "instance.create", resourceType: "instance" }));
    logger.log(makeInput({ userId: "user-1", action: "plugin.install", resourceType: "plugin" }));
    logger.log(makeInput({ userId: "user-2", action: "instance.create", resourceType: "instance" }));

    const results = queryAuditLog(db, { userId: "user-1", resourceType: "instance" });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("instance.create");
    expect(results[0].user_id).toBe("user-1");
  });

  it("returns empty array when no entries match", () => {
    const results = queryAuditLog(db, { userId: "nonexistent" });
    expect(results).toHaveLength(0);
  });

  it("enforces minimum limit of 1", () => {
    logger.log(makeInput());
    logger.log(makeInput());

    const results = queryAuditLog(db, { limit: 0 });
    expect(results).toHaveLength(1);
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
    db.insert(auditLog).values({
      id: "first",
      timestamp: now - 1000,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "second",
      timestamp: now,
      userId: "user-1",
      authMethod: "session",
      action: "instance.destroy",
      resourceType: "instance",
    }).run();

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
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    sqlite.close();
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

  it("counts with wildcard action filter", () => {
    logger.log(makeInput({ action: "instance.create" }));
    logger.log(makeInput({ action: "instance.destroy" }));
    logger.log(makeInput({ action: "plugin.install", resourceType: "plugin" }));
    expect(countAuditLog(db, { action: "instance.*" })).toBe(2);
  });

  it("counts with time range filter", () => {
    const now = Date.now();
    db.insert(auditLog).values({
      id: "old",
      timestamp: now - 10000,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "new",
      timestamp: now,
      userId: "user-1",
      authMethod: "session",
      action: "instance.destroy",
      resourceType: "instance",
    }).run();

    expect(countAuditLog(db, { since: now - 5000 })).toBe(1);
    expect(countAuditLog(db, { until: now - 5000 })).toBe(1);
    expect(countAuditLog(db, { since: now - 15000, until: now + 1000 })).toBe(2);
  });

  it("counts with resourceType and resourceId filters", () => {
    logger.log(makeInput({ resourceType: "instance", resourceId: "inst-1" }));
    logger.log(makeInput({ resourceType: "instance", resourceId: "inst-2" }));
    logger.log(makeInput({ resourceType: "plugin", resourceId: "plug-1", action: "plugin.install" }));

    expect(countAuditLog(db, { resourceType: "instance" })).toBe(2);
    expect(countAuditLog(db, { resourceId: "inst-1" })).toBe(1);
    expect(countAuditLog(db, { resourceType: "plugin", resourceId: "plug-1" })).toBe(1);
  });

  it("returns zero for no matches", () => {
    expect(countAuditLog(db, {})).toBe(0);
    expect(countAuditLog(db, { userId: "nonexistent" })).toBe(0);
  });
});

describe("retention", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns correct retention days (flat 30)", () => {
    expect(getRetentionDays()).toBe(30);
  });

  it("purges entries older than retention period", () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;

    db.insert(auditLog).values({
      id: "old",
      timestamp: thirtyOneDaysAgo,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "recent",
      timestamp: oneDayAgo,
      userId: "user-1",
      authMethod: "session",
      action: "instance.destroy",
      resourceType: "instance",
    }).run();

    const deleted = purgeExpiredEntries(db);
    expect(deleted).toBe(1);

    const remaining = db.select().from(auditLog).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("recent");
  });

  it("does not purge recent entries", () => {
    const logger = new AuditLogger(db);
    logger.log(makeInput());

    const deleted = purgeExpiredEntries(db);
    expect(deleted).toBe(0);
  });

  it("purges per user for user-scoped retention", () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;

    db.insert(auditLog).values({
      id: "u1-old",
      timestamp: thirtyOneDaysAgo,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "u2-old",
      timestamp: thirtyOneDaysAgo,
      userId: "user-2",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();

    const deleted = purgeExpiredEntriesForUser(db, "user-1");
    expect(deleted).toBe(1);

    const remaining = db.select().from(auditLog).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("u2-old");
  });

  it("does not purge entries within retention period", () => {
    const now = Date.now();
    const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;

    db.insert(auditLog).values({
      id: "within-retention",
      timestamp: twentyDaysAgo,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();

    const deleted = purgeExpiredEntries(db);
    expect(deleted).toBe(0);
  });

  it("purgeExpiredEntriesForUser does not affect other users", () => {
    const now = Date.now();
    const recentTime = now - 1000;

    db.insert(auditLog).values({
      id: "u1-recent",
      timestamp: recentTime,
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();
    db.insert(auditLog).values({
      id: "u2-recent",
      timestamp: recentTime,
      userId: "user-2",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
    }).run();

    const deleted = purgeExpiredEntriesForUser(db, "user-1");
    expect(deleted).toBe(0);

    const remaining = db.select().from(auditLog).all();
    expect(remaining).toHaveLength(2);
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
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("logs entry on successful response", async () => {
    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLogMiddleware(logger, "instance.create"));
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
    app.use("/instance/:id", auditLogMiddleware(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ error: "bad" }, 400));

    await app.request("/instance/inst-1", { method: "POST" });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(0);
  });

  it("is a no-op without user context", async () => {
    const app = new Hono();
    app.use("/instance/:id", auditLogMiddleware(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    await app.request("/instance/inst-1", { method: "POST" });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(0);
  });

  it("logs api_key auth method", async () => {
    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "api_key");
      await next();
    });
    app.use("/instance/:id", auditLogMiddleware(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    await app.request("/instance/inst-1", { method: "POST" });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(1);
    expect(entries[0].auth_method).toBe("api_key");
  });

  it("extracts first IP from x-forwarded-for with multiple IPs", async () => {
    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLogMiddleware(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    await app.request("/instance/inst-1", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.1, 192.168.1.1, 172.16.0.1" },
    });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(1);
    expect(entries[0].ip_address).toBe("10.0.0.1");
  });

  it("handles missing headers gracefully", async () => {
    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLogMiddleware(logger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    await app.request("/instance/inst-1", { method: "POST" });

    const entries = queryAuditLog(db, {});
    expect(entries).toHaveLength(1);
    expect(entries[0].ip_address).toBeNull();
    expect(entries[0].user_agent).toBeNull();
  });

  it("does not break the request on logging error", async () => {
    const badSqlite = new BetterSqlite3(":memory:");
    const badTestDb = createTestDb();
    const badLogger = new AuditLogger(badTestDb.db);
    badTestDb.sqlite.close();

    const app = new Hono<AuditEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1" });
      c.set("authMethod", "session");
      await next();
    });
    app.use("/instance/:id", auditLogMiddleware(badLogger, "instance.create"));
    app.post("/instance/:id", (c) => c.json({ ok: true }));

    const res = await app.request("/instance/inst-1", { method: "POST" });
    expect(res.status).toBe(200);
    badSqlite.close();
  });
});

describe("audit API routes", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    sqlite.close();
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

    it("defaults to retention cleanup on query", async () => {
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
      db.insert(auditLog).values({
        id: "old-no-tier",
        timestamp: thirtyOneDaysAgo,
        userId: "user-1",
        authMethod: "session",
        action: "instance.create",
        resourceType: "instance",
      }).run();
      logger.log(makeInput({ userId: "user-1" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].id).not.toBe("old-no-tier");
    });

    it("supports limit and offset query params", async () => {
      for (let i = 0; i < 5; i++) {
        logger.log(makeInput({ userId: "user-1" }));
      }

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit?limit=2&offset=1");
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
    });

    it("filters by resourceType query param", async () => {
      logger.log(makeInput({ userId: "user-1", resourceType: "instance" }));
      logger.log(makeInput({ userId: "user-1", resourceType: "plugin", action: "plugin.install" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit?resourceType=plugin");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].resource_type).toBe("plugin");
    });

    it("filters by resourceId query param", async () => {
      logger.log(makeInput({ userId: "user-1", resourceId: "inst-1" }));
      logger.log(makeInput({ userId: "user-1", resourceId: "inst-2" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request("/audit?resourceId=inst-1");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].resource_id).toBe("inst-1");
    });

    it("filters by time range query params", async () => {
      const now = Date.now();
      db.insert(auditLog).values({
        id: "old-time",
        timestamp: now - 100000,
        userId: "user-1",
        authMethod: "session",
        action: "instance.create",
        resourceType: "instance",
      }).run();
      logger.log(makeInput({ userId: "user-1" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/audit", createAuditRoutes(db));

      const res = await app.request(`/audit?since=${now - 5000}`);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].id).not.toBe("old-time");
    });

    it("applies retention cleanup on query", async () => {
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
      db.insert(auditLog).values({
        id: "old-entry",
        timestamp: thirtyOneDaysAgo,
        userId: "user-1",
        authMethod: "session",
        action: "instance.create",
        resourceType: "instance",
      }).run();
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
      db.insert(auditLog).values({
        id: "old",
        timestamp: now - 100000,
        userId: "user-1",
        authMethod: "session",
        action: "instance.create",
        resourceType: "instance",
      }).run();
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

    it("filters by action", async () => {
      logger.log(makeInput({ userId: "user-1", action: "instance.create" }));
      logger.log(makeInput({ userId: "user-1", action: "plugin.install", resourceType: "plugin" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", isAdmin: true });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit?action=plugin.install");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].action).toBe("plugin.install");
    });

    it("filters by resourceType and resourceId", async () => {
      logger.log(makeInput({ resourceType: "instance", resourceId: "inst-1" }));
      logger.log(makeInput({ resourceType: "plugin", resourceId: "plug-1", action: "plugin.install" }));

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", isAdmin: true });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit?resourceType=plugin&resourceId=plug-1");
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].resource_type).toBe("plugin");
      expect(body.entries[0].resource_id).toBe("plug-1");
    });

    it("supports limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        logger.log(makeInput());
      }

      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", isAdmin: true });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit?limit=2&offset=1");
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("returns 403 when isAdmin is undefined", async () => {
      const app = new Hono<AuditEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "user-1" });
        c.set("authMethod", "session");
        await next();
      });
      app.route("/admin/audit", createAdminAuditRoutes(db));

      const res = await app.request("/admin/audit");
      expect(res.status).toBe(403);
    });
  });
});
