import { beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleAuditLogRepository, type IAuditLogRepository } from "./audit-log-repository.js";
import { AuditLogger } from "./logger.js";
import { countAuditLog, queryAuditLog } from "./query.js";

describe("queryAuditLog", () => {
  let db: DrizzleDb;
  let repo: IAuditLogRepository;
  let logger: AuditLogger;

  beforeEach(() => {
    ({ db } = createTestDb());
    repo = new DrizzleAuditLogRepository(db);
    logger = new AuditLogger(repo);

    // Seed test data
    logger.log({
      userId: "u1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
      resourceId: "bot-1",
    });
    logger.log({
      userId: "u1",
      authMethod: "session",
      action: "instance.stop",
      resourceType: "instance",
      resourceId: "bot-1",
    });
    logger.log({ userId: "u2", authMethod: "api_key", action: "auth.login", resourceType: "user" });
    logger.log({
      userId: "u1",
      authMethod: "session",
      action: "plugin.install",
      resourceType: "plugin",
      resourceId: "p-1",
    });
  });

  it("returns all entries when no filters", () => {
    const entries = queryAuditLog(repo, {});
    expect(entries).toHaveLength(4);
  });

  it("filters by userId", () => {
    const entries = queryAuditLog(repo, { userId: "u1" });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.user_id === "u1")).toBe(true);
  });

  it("filters by exact action", () => {
    const entries = queryAuditLog(repo, { action: "auth.login" });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("auth.login");
  });

  it("filters by wildcard action (prefix match)", () => {
    const entries = queryAuditLog(repo, { action: "instance.*" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.action.startsWith("instance."))).toBe(true);
  });

  it("filters by resourceType", () => {
    const entries = queryAuditLog(repo, { resourceType: "plugin" });
    expect(entries).toHaveLength(1);
    expect(entries[0].resource_type).toBe("plugin");
  });

  it("filters by resourceId", () => {
    const entries = queryAuditLog(repo, { resourceId: "bot-1" });
    expect(entries).toHaveLength(2);
  });

  it("filters by time range (since/until)", () => {
    const now = Date.now();
    // All entries were created at approximately 'now', so filtering for future should return 0
    const entries = queryAuditLog(repo, { since: now + 10_000 });
    expect(entries).toHaveLength(0);
  });

  it("respects limit", () => {
    const entries = queryAuditLog(repo, { limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("caps limit at MAX_LIMIT (250)", () => {
    const entries = queryAuditLog(repo, { limit: 999 });
    // Should not crash and should return all 4 (which is less than 250)
    expect(entries).toHaveLength(4);
  });

  it("applies offset", () => {
    const all = queryAuditLog(repo, {});
    const withOffset = queryAuditLog(repo, { offset: 2 });
    expect(withOffset).toHaveLength(2);
    expect(withOffset[0].id).toBe(all[2].id);
  });

  it("orders by timestamp descending", () => {
    const entries = queryAuditLog(repo, {});
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i + 1].timestamp);
    }
  });

  it("maps fields to snake_case", () => {
    const entries = queryAuditLog(repo, { userId: "u1", limit: 1 });
    expect(entries[0]).toHaveProperty("user_id");
    expect(entries[0]).toHaveProperty("auth_method");
    expect(entries[0]).toHaveProperty("resource_type");
    expect(entries[0]).toHaveProperty("resource_id");
    expect(entries[0]).toHaveProperty("ip_address");
    expect(entries[0]).toHaveProperty("user_agent");
  });

  it("combines multiple filters", () => {
    const entries = queryAuditLog(repo, {
      userId: "u1",
      resourceType: "instance",
    });
    expect(entries).toHaveLength(2);
  });
});

describe("countAuditLog", () => {
  let db: DrizzleDb;
  let repo: IAuditLogRepository;
  let logger: AuditLogger;

  beforeEach(() => {
    ({ db } = createTestDb());
    repo = new DrizzleAuditLogRepository(db);
    logger = new AuditLogger(repo);

    logger.log({ userId: "u1", authMethod: "session", action: "instance.create", resourceType: "instance" });
    logger.log({ userId: "u1", authMethod: "session", action: "instance.stop", resourceType: "instance" });
    logger.log({ userId: "u2", authMethod: "api_key", action: "auth.login", resourceType: "user" });
  });

  it("counts all entries when no filters", () => {
    expect(countAuditLog(repo, {})).toBe(3);
  });

  it("counts with userId filter", () => {
    expect(countAuditLog(repo, { userId: "u1" })).toBe(2);
  });

  it("counts with action filter", () => {
    expect(countAuditLog(repo, { action: "auth.login" })).toBe(1);
  });

  it("returns 0 for non-matching filter", () => {
    expect(countAuditLog(repo, { userId: "nonexistent" })).toBe(0);
  });
});
