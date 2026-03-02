import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, truncateAllTables } from "../test/db.js";
import type { DrizzleDb } from "./index.js";
import { DrizzleTenantModelSelectionRepository } from "./tenant-model-selection-repository.js";

describe("DrizzleTenantModelSelectionRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleTenantModelSelectionRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleTenantModelSelectionRepository(db);
  });

  describe("getDefaultModel", () => {
    it("returns 'openrouter/auto' when no selection exists", async () => {
      const model = await repo.getDefaultModel("t-1");
      expect(model).toBe("openrouter/auto");
    });

    it("returns the set model after setDefaultModel", async () => {
      await repo.setDefaultModel("t-1", "anthropic/claude-3.5-sonnet");
      const model = await repo.getDefaultModel("t-1");
      expect(model).toBe("anthropic/claude-3.5-sonnet");
    });
  });

  describe("setDefaultModel", () => {
    it("upserts on conflict (updates existing)", async () => {
      await repo.setDefaultModel("t-1", "gpt-4");
      await repo.setDefaultModel("t-1", "claude-3");

      const model = await repo.getDefaultModel("t-1");
      expect(model).toBe("claude-3");
    });

    it("handles multiple tenants independently", async () => {
      await repo.setDefaultModel("t-1", "gpt-4");
      await repo.setDefaultModel("t-2", "claude-3");

      expect(await repo.getDefaultModel("t-1")).toBe("gpt-4");
      expect(await repo.getDefaultModel("t-2")).toBe("claude-3");
    });

    it("persists model across multiple sets", async () => {
      await repo.setDefaultModel("t-1", "model-a");
      await repo.setDefaultModel("t-1", "model-b");
      await repo.setDefaultModel("t-1", "model-c");

      expect(await repo.getDefaultModel("t-1")).toBe("model-c");
    });
  });
});
