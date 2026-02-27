import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { SetupService } from "./setup-service.js";
import { DrizzleSetupSessionRepository } from "./setup-session-repository.js";

describe("SetupService", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleSetupSessionRepository;
  let service: SetupService;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleSetupSessionRepository(db);
    service = new SetupService(repo);
  });

  describe("rollback", () => {
    it("marks session as rolled_back and returns rollback result", async () => {
      await repo.insert({
        id: "s-1",
        sessionId: "chat-1",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: Date.now(),
      });
      await repo.update("s-1", {
        collected: JSON.stringify({ apiKey: "sk-xxx" }),
        dependenciesInstalled: JSON.stringify(["@wopr/plugin-a"]),
      });

      const result = await service.rollback("s-1");

      expect(result.sessionId).toBe("s-1");
      expect(result.configKeysRemoved).toEqual(["apiKey"]);
      expect(result.dependenciesRemoved).toEqual(["@wopr/plugin-a"]);

      const updated = await repo.findById("s-1");
      expect(updated?.status).toBe("rolled_back");
      expect(updated?.collected).toBeNull();
      expect(updated?.dependenciesInstalled).toBeNull();
    });

    it("is idempotent — rolling back twice does not throw", async () => {
      await repo.insert({
        id: "s-2",
        sessionId: "chat-2",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: Date.now(),
      });

      await service.rollback("s-2");
      const result = await service.rollback("s-2");

      expect(result.configKeysRemoved).toEqual([]);
      expect(result.dependenciesRemoved).toEqual([]);
    });

    it("throws for non-existent session", async () => {
      await expect(service.rollback("no-such-id")).rejects.toThrow("SetupSession not found");
    });
  });

  describe("recordError", () => {
    it("increments error count and returns new count", async () => {
      await repo.insert({
        id: "s-3",
        sessionId: "chat-3",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: Date.now(),
      });

      const count1 = await service.recordError("s-3");
      expect(count1).toBe(1);

      const count2 = await service.recordError("s-3");
      expect(count2).toBe(2);
    });

    it("auto-rolls back after 3 consecutive errors", async () => {
      await repo.insert({
        id: "s-4",
        sessionId: "chat-4",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: Date.now(),
      });

      await service.recordError("s-4");
      await service.recordError("s-4");
      const result = await service.recordError("s-4");

      expect(result).toBe(3);
      const session = await repo.findById("s-4");
      expect(session?.status).toBe("rolled_back");
    });
  });

  describe("recordSuccess", () => {
    it("resets error count to 0", async () => {
      await repo.insert({
        id: "s-5",
        sessionId: "chat-5",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: Date.now(),
      });

      await service.recordError("s-5");
      await service.recordError("s-5");
      await service.recordSuccess("s-5");

      const session = await repo.findById("s-5");
      expect(session?.errorCount).toBe(0);
    });
  });

  describe("cleanupStaleSessions", () => {
    it("rolls back sessions older than the threshold", async () => {
      const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;
      await repo.insert({
        id: "s-6",
        sessionId: "chat-6",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: thirtyOneMinutesAgo,
      });
      await repo.insert({
        id: "s-7",
        sessionId: "chat-7",
        pluginId: "plugin-b",
        status: "in_progress",
        startedAt: Date.now(),
      });

      const rolledBack = await service.cleanupStaleSessions(30 * 60 * 1000);

      expect(rolledBack).toHaveLength(1);
      expect(rolledBack[0].sessionId).toBe("s-6");

      const stale = await repo.findById("s-6");
      expect(stale?.status).toBe("rolled_back");

      const fresh = await repo.findById("s-7");
      expect(fresh?.status).toBe("in_progress");
    });

    it("returns empty array when no stale sessions exist", async () => {
      const result = await service.cleanupStaleSessions(30 * 60 * 1000);
      expect(result).toEqual([]);
    });
  });

  describe("checkForResumable", () => {
    it("returns stale session when one exists for the sessionId", async () => {
      await repo.insert({
        id: "s-8",
        sessionId: "chat-8",
        pluginId: "plugin-a",
        status: "in_progress",
        startedAt: Date.now(),
      });

      const result = await service.checkForResumable("chat-8");

      expect(result.hasStaleSession).toBe(true);
      expect(result.session?.id).toBe("s-8");
    });

    it("returns hasStaleSession=false when no in-progress session", async () => {
      const result = await service.checkForResumable("chat-99");
      expect(result.hasStaleSession).toBe(false);
      expect(result.session).toBeUndefined();
    });
  });
});
