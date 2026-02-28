import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { runDeletionCron } from "./deletion-cron.js";
import type { DeletionExecutorDeps } from "./deletion-executor.js";
import { DrizzleDeletionExecutorRepository } from "./deletion-executor-repository.js";
import { DrizzleDeletionRepository } from "./deletion-repository.js";
import { AccountDeletionStore } from "./deletion-store.js";

let db: DrizzleDb;
let pool: PGlite;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("runDeletionCron", () => {
  let store: AccountDeletionStore;
  let executorDeps: DeletionExecutorDeps;

  beforeEach(async () => {
    await truncateAllTables(pool);
    const deletionRepo = new DrizzleDeletionRepository(db);
    store = new AccountDeletionStore(deletionRepo);
    const execRepo = new DrizzleDeletionExecutorRepository(db);
    executorDeps = { repo: execRepo };
  });

  it("processes expired requests and marks them completed", async () => {
    await pool.query(`
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ('expired-1', 'tenant-exp-1', 'user-1', 'pending', (now() - interval '1 day')::text)
    `);

    const cronResult = await runDeletionCron(store, executorDeps);

    expect(cronResult.processed).toBeGreaterThanOrEqual(1);
    expect(cronResult.succeeded).toBeGreaterThanOrEqual(1);
    expect(cronResult.failed).toBe(0);

    const updated = await store.getById("expired-1");
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeTruthy();
  });

  it("skips non-expired pending requests", async () => {
    const req = await store.create("tenant-future", "user-future");

    const cronResult = await runDeletionCron(store, executorDeps);

    expect(cronResult.processed).toBe(0);
    const still = await store.getById(req.id);
    expect(still?.status).toBe("pending");
  });

  it("skips cancelled requests even if deleteAfter is in the past", async () => {
    await pool.query(`
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ('cancelled-old', 'tenant-c', 'user-c', 'cancelled', (now() - interval '1 day')::text)
    `);

    const cronResult = await runDeletionCron(store, executorDeps);

    expect(cronResult.processed).toBe(0);
    const req = await store.getById("cancelled-old");
    expect(req?.status).toBe("cancelled");
  });

  it("continues processing and reports failures when an executor error occurs", async () => {
    await pool.query(`
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ('expired-err', 'tenant-err', 'user-err', 'pending', (now() - interval '1 day')::text)
    `);

    const mockExecute = vi.fn().mockRejectedValue(new Error("Executor blew up"));

    const { runDeletionCronWithExecutor } = await import("./deletion-cron.js");
    const cronResult = await runDeletionCronWithExecutor(store, executorDeps, mockExecute);

    expect(cronResult.processed).toBeGreaterThanOrEqual(1);
    expect(cronResult.failed).toBeGreaterThanOrEqual(1);
    expect(cronResult.succeeded).toBe(0);
  });
});
