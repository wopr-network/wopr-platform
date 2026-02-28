/**
 * Unit tests for DrizzleFleetEventRepository (WOP-927).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleFleetEventRepository } from "./drizzle-fleet-event-repository.js";

describe("DrizzleFleetEventRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleFleetEventRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
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
});
