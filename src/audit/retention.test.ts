import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleAuditLogRepository, type IAuditLogRepository } from "./audit-log-repository.js";
import { AuditLogger } from "./logger.js";
import { queryAuditLog } from "./query.js";
import { getRetentionDays, purgeExpiredEntries, purgeExpiredEntriesForUser } from "./retention.js";

describe("audit retention", () => {
  let db: DrizzleDb;
  let repo: IAuditLogRepository;
  let logger: AuditLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ db } = createTestDb());
    repo = new DrizzleAuditLogRepository(db);
    logger = new AuditLogger(repo);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getRetentionDays", () => {
    it("returns 365 days", () => {
      expect(getRetentionDays()).toBe(365);
    });
  });

  describe("purgeExpiredEntries", () => {
    it("deletes entries older than 365 days", () => {
      // Create an entry "now"
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.create", resourceType: "instance" });

      // Create an entry at day 180
      vi.setSystemTime(new Date("2025-07-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.stop", resourceType: "instance" });

      // Advance to day 366 — first entry is now >365 days old
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
      const deleted = purgeExpiredEntries(repo);

      expect(deleted).toBe(1);
      const remaining = queryAuditLog(repo, {});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].action).toBe("instance.stop");
    });

    it("returns 0 when no entries are expired", () => {
      logger.log({ userId: "u1", authMethod: "session", action: "auth.login", resourceType: "user" });
      const deleted = purgeExpiredEntries(repo);
      expect(deleted).toBe(0);
    });

    it("returns 0 for empty database", () => {
      const deleted = purgeExpiredEntries(repo);
      expect(deleted).toBe(0);
    });
  });

  describe("purgeExpiredEntriesForUser", () => {
    it("only deletes expired entries for the specified user", () => {
      // Create old entries for both users
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.create", resourceType: "instance" });
      logger.log({ userId: "u2", authMethod: "api_key", action: "auth.login", resourceType: "user" });

      // Create recent entry for u1
      vi.setSystemTime(new Date("2025-07-01T00:00:00Z"));
      logger.log({ userId: "u1", authMethod: "session", action: "instance.stop", resourceType: "instance" });

      // Advance past 365 days from the old entries
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));

      const deleted = purgeExpiredEntriesForUser(repo, "u1");
      expect(deleted).toBe(1);

      // u2's old entry should still exist
      const u2Entries = queryAuditLog(repo, { userId: "u2" });
      expect(u2Entries).toHaveLength(1);

      // u1's recent entry should still exist
      const u1Entries = queryAuditLog(repo, { userId: "u1" });
      expect(u1Entries).toHaveLength(1);
      expect(u1Entries[0].action).toBe("instance.stop");
    });

    it("returns 0 when user has no expired entries", () => {
      logger.log({ userId: "u1", authMethod: "session", action: "auth.login", resourceType: "user" });
      const deleted = purgeExpiredEntriesForUser(repo, "u1");
      expect(deleted).toBe(0);
    });

    it("returns 0 for non-existent user", () => {
      const deleted = purgeExpiredEntriesForUser(repo, "nonexistent");
      expect(deleted).toBe(0);
    });
  });
});
