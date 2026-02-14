import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../test/db.js";
import type { DrizzleDb } from "../db/index.js";
import { AuditLogger } from "./logger.js";
import { getRetentionDays, purgeExpiredEntries, purgeExpiredEntriesForUser } from "./retention.js";
import { queryAuditLog } from "./query.js";

describe("audit retention", () => {
  let db: DrizzleDb;
  let logger: AuditLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ db } = createTestDb());
    logger = new AuditLogger(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getRetentionDays", () => {
    it("returns 30 days", () => {
      expect(getRetentionDays()).toBe(30);
    });
  });

  describe("purgeExpiredEntries", () => {
    it("deletes entries older than 30 days", () => {
      // Create an entry "now"
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.create", resourceType: "instance" });

      // Create an entry at day 15
      vi.setSystemTime(new Date("2026-01-16T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.stop", resourceType: "instance" });

      // Advance to day 31 — first entry is now >30 days old
      vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
      const deleted = purgeExpiredEntries(db);

      expect(deleted).toBe(1);
      const remaining = queryAuditLog(db, {});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].action).toBe("instance.stop");
    });

    it("returns 0 when no entries are expired", () => {
      logger.log({ userId: "u1", authMethod: "session", action: "auth.login", resourceType: "user" });
      const deleted = purgeExpiredEntries(db);
      expect(deleted).toBe(0);
    });

    it("returns 0 for empty database", () => {
      const deleted = purgeExpiredEntries(db);
      expect(deleted).toBe(0);
    });
  });

  describe("purgeExpiredEntriesForUser", () => {
    it("only deletes expired entries for the specified user", () => {
      // Create old entries for both users
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.create", resourceType: "instance" });
      logger.log({ userId: "u2", authMethod: "api_key", action: "auth.login", resourceType: "user" });

      // Create recent entry for u1
      vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.stop", resourceType: "instance" });

      // Advance past 30 days from the old entries
      vi.setSystemTime(new Date("2026-02-02T00:00:00Z"));

      const deleted = purgeExpiredEntriesForUser(db, "u1");
      expect(deleted).toBe(1);

      // u2's old entry should still exist
      const u2Entries = queryAuditLog(db, { userId: "u2" });
      expect(u2Entries).toHaveLength(1);

      // u1's recent entry should still exist
      const u1Entries = queryAuditLog(db, { userId: "u1" });
      expect(u1Entries).toHaveLength(1);
      expect(u1Entries[0].action).toBe("instance.stop");
    });

    it("returns 0 when user has no expired entries", () => {
      logger.log({ userId: "u1", authMethod: "session", action: "auth.login", resourceType: "user" });
      const deleted = purgeExpiredEntriesForUser(db, "u1");
      expect(deleted).toBe(0);
    });

    it("returns 0 for non-existent user", () => {
      const deleted = purgeExpiredEntriesForUser(db, "nonexistent");
      expect(deleted).toBe(0);
    });
  });
});
