/**
 * Unit tests for DrizzleFleetEventRepository (WOP-927).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../test/db.js";
import { DrizzleFleetEventRepository } from "./drizzle-fleet-event-repository.js";

describe("DrizzleFleetEventRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleFleetEventRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    repo = new DrizzleFleetEventRepository(db);
  });

  it("isFleetStopFired returns false initially", async () => {
    expect(await repo.isFleetStopFired()).toBe(false);
  });

  it("fireFleetStop sets fired = true", async () => {
    await repo.fireFleetStop();
    expect(await repo.isFleetStopFired()).toBe(true);
  });

  it("clearFleetStop sets fired = false", async () => {
    await repo.fireFleetStop();
    await repo.clearFleetStop();
    expect(await repo.isFleetStopFired()).toBe(false);
  });

  it("fireFleetStop is idempotent", async () => {
    await repo.fireFleetStop();
    await repo.fireFleetStop();
    expect(await repo.isFleetStopFired()).toBe(true);
  });

  it("clearFleetStop is idempotent when not fired", async () => {
    await expect(repo.clearFleetStop()).resolves.not.toThrow();
    expect(await repo.isFleetStopFired()).toBe(false);
  });

  it("append persists a fleet event", async () => {
    await repo.append({
      eventType: "bot.started",
      botId: "bot-1",
      tenantId: "tenant-1",
      createdAt: Date.now(),
    });
    const rows = await repo.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("bot.started");
    expect(rows[0].botId).toBe("bot-1");
    expect(rows[0].tenantId).toBe("tenant-1");
  });

  it("list filters by botId", async () => {
    const now = Date.now();
    await repo.append({ eventType: "bot.started", botId: "bot-1", tenantId: "t1", createdAt: now });
    await repo.append({ eventType: "bot.stopped", botId: "bot-2", tenantId: "t1", createdAt: now });
    const rows = await repo.list({ botId: "bot-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].botId).toBe("bot-1");
  });

  it("list filters by tenantId", async () => {
    const now = Date.now();
    await repo.append({ eventType: "bot.started", botId: "bot-1", tenantId: "t1", createdAt: now });
    await repo.append({ eventType: "bot.started", botId: "bot-2", tenantId: "t2", createdAt: now });
    const rows = await repo.list({ tenantId: "t1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("t1");
  });

  it("list filters by type", async () => {
    const now = Date.now();
    await repo.append({ eventType: "bot.started", botId: "bot-1", tenantId: "t1", createdAt: now });
    await repo.append({ eventType: "bot.stopped", botId: "bot-1", tenantId: "t1", createdAt: now });
    const rows = await repo.list({ type: "bot.started" });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("bot.started");
  });

  it("list filters by since", async () => {
    const now = Date.now();
    await repo.append({ eventType: "bot.started", botId: "bot-1", tenantId: "t1", createdAt: now - 10000 });
    await repo.append({ eventType: "bot.stopped", botId: "bot-1", tenantId: "t1", createdAt: now });
    const rows = await repo.list({ since: now - 5000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("bot.stopped");
  });

  it("list respects limit", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await repo.append({ eventType: "bot.started", botId: `bot-${i}`, tenantId: "t1", createdAt: now + i });
    }
    const rows = await repo.list({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it("list returns newest first", async () => {
    const now = Date.now();
    await repo.append({ eventType: "bot.started", botId: "bot-1", tenantId: "t1", createdAt: now });
    await repo.append({ eventType: "bot.stopped", botId: "bot-2", tenantId: "t1", createdAt: now + 1000 });
    const rows = await repo.list({});
    expect(rows[0].createdAt).toBeGreaterThan(rows[1].createdAt);
  });

  it("list with no results returns empty array", async () => {
    const rows = await repo.list({ botId: "nonexistent" });
    expect(rows).toEqual([]);
  });
});
