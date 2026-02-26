import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleAuditLogRepository, type IAuditLogRepository } from "./audit-log-repository.js";
import { AuditLogger } from "./logger.js";
import { countAuditLog, queryAuditLog } from "./query.js";

describe("queryAuditLog", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: IAuditLogRepository;
  let logger: AuditLogger;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleAuditLogRepository(db);
    logger = new AuditLogger(repo);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    // Seed test data
    await logger.log({
      userId: "u1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
      resourceId: "bot-1",
    });
    await logger.log({
      userId: "u1",
      authMethod: "session",
      action: "instance.stop",
      resourceType: "instance",
      resourceId: "bot-1",
    });
    await logger.log({ userId: "u2", authMethod: "api_key", action: "auth.login", resourceType: "user" });
    await logger.log({
      userId: "u1",
      authMethod: "session",
      action: "plugin.install",
      resourceType: "plugin",
      resourceId: "p-1",
    });
    // Wait for async inserts to complete
    await new Promise((r) => setTimeout(r, 50));
  });

  it("returns all entries when no filters", async () => {
    const entries = await queryAuditLog(repo, {});
    expect(entries).toHaveLength(4);
  });

  it("filters by userId", async () => {
    const entries = await queryAuditLog(repo, { userId: "u1" });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.user_id === "u1")).toBe(true);
  });

  it("filters by exact action", async () => {
    const entries = await queryAuditLog(repo, { action: "auth.login" });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("auth.login");
  });

  it("filters by wildcard action (prefix match)", async () => {
    const entries = await queryAuditLog(repo, { action: "instance.*" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.action.startsWith("instance."))).toBe(true);
  });

  it("filters by resourceType", async () => {
    const entries = await queryAuditLog(repo, { resourceType: "plugin" });
    expect(entries).toHaveLength(1);
    expect(entries[0].resource_type).toBe("plugin");
  });

  it("filters by resourceId", async () => {
    const entries = await queryAuditLog(repo, { resourceId: "bot-1" });
    expect(entries).toHaveLength(2);
  });

  it("filters by time range (since/until)", async () => {
    const now = Date.now();
    // All entries were created at approximately 'now', so filtering for future should return 0
    const entries = await queryAuditLog(repo, { since: now + 10_000 });
    expect(entries).toHaveLength(0);
  });

  it("respects limit", async () => {
    const entries = await queryAuditLog(repo, { limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("caps limit at MAX_LIMIT (250)", async () => {
    const entries = await queryAuditLog(repo, { limit: 999 });
    // Should not crash and should return all 4 (which is less than 250)
    expect(entries).toHaveLength(4);
  });

  it("applies offset", async () => {
    const all = await queryAuditLog(repo, {});
    const withOffset = await queryAuditLog(repo, { offset: 2 });
    expect(withOffset).toHaveLength(2);
    expect(withOffset[0].id).toBe(all[2].id);
  });

  it("orders by timestamp descending", async () => {
    const entries = await queryAuditLog(repo, {});
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i + 1].timestamp);
    }
  });

  it("maps fields to snake_case", async () => {
    const entries = await queryAuditLog(repo, { userId: "u1", limit: 1 });
    expect(entries[0]).toHaveProperty("user_id");
    expect(entries[0]).toHaveProperty("auth_method");
    expect(entries[0]).toHaveProperty("resource_type");
    expect(entries[0]).toHaveProperty("resource_id");
    expect(entries[0]).toHaveProperty("ip_address");
    expect(entries[0]).toHaveProperty("user_agent");
  });

  it("combines multiple filters", async () => {
    const entries = await queryAuditLog(repo, {
      userId: "u1",
      resourceType: "instance",
    });
    expect(entries).toHaveLength(2);
  });
});

describe("countAuditLog", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: IAuditLogRepository;
  let logger: AuditLogger;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleAuditLogRepository(db);
    logger = new AuditLogger(repo);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    await logger.log({ userId: "u1", authMethod: "session", action: "instance.create", resourceType: "instance" });
    await logger.log({ userId: "u1", authMethod: "session", action: "instance.stop", resourceType: "instance" });
    await logger.log({ userId: "u2", authMethod: "api_key", action: "auth.login", resourceType: "user" });
    // Wait for async inserts to complete
    await new Promise((r) => setTimeout(r, 50));
  });

  it("counts all entries when no filters", async () => {
    expect(await countAuditLog(repo, {})).toBe(3);
  });

  it("counts with userId filter", async () => {
    expect(await countAuditLog(repo, { userId: "u1" })).toBe(2);
  });

  it("counts with action filter", async () => {
    expect(await countAuditLog(repo, { action: "auth.login" })).toBe(1);
  });

  it("returns 0 for non-matching filter", async () => {
    expect(await countAuditLog(repo, { userId: "nonexistent" })).toBe(0);
  });
});
