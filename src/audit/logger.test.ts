import { beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { AuditLogger } from "./logger.js";
import { queryAuditLog } from "./query.js";

describe("AuditLogger", () => {
  let db: DrizzleDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("creates an entry with all fields", () => {
    const logger = new AuditLogger(db);
    const entry = logger.log({
      userId: "user-1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
      resourceId: "bot-1",
      details: { image: "alpine:latest" },
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
    });

    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.user_id).toBe("user-1");
    expect(entry.auth_method).toBe("session");
    expect(entry.action).toBe("instance.create");
    expect(entry.resource_type).toBe("instance");
    expect(entry.resource_id).toBe("bot-1");
    expect(entry.details).toBe(JSON.stringify({ image: "alpine:latest" }));
    expect(entry.ip_address).toBe("10.0.0.1");
    expect(entry.user_agent).toBe("TestAgent/1.0");
  });

  it("creates an entry with minimal fields (nulls for optional)", () => {
    const logger = new AuditLogger(db);
    const entry = logger.log({
      userId: "user-2",
      authMethod: "api_key",
      action: "auth.login",
      resourceType: "user",
    });

    expect(entry.resource_id).toBeNull();
    expect(entry.details).toBeNull();
    expect(entry.ip_address).toBeNull();
    expect(entry.user_agent).toBeNull();
  });

  it("generates unique IDs for each entry", () => {
    const logger = new AuditLogger(db);
    const e1 = logger.log({
      userId: "u1",
      authMethod: "session",
      action: "auth.login",
      resourceType: "user",
    });
    const e2 = logger.log({
      userId: "u1",
      authMethod: "session",
      action: "auth.logout",
      resourceType: "user",
    });

    expect(e1.id).not.toBe(e2.id);
  });

  it("persists entries to the database", () => {
    const logger = new AuditLogger(db);
    logger.log({
      userId: "u1",
      authMethod: "session",
      action: "instance.create",
      resourceType: "instance",
      resourceId: "bot-1",
    });

    // Query using the audit query module to verify persistence
    const rows = queryAuditLog(db, { userId: "u1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe("u1");
    expect(rows[0].action).toBe("instance.create");
  });
});
