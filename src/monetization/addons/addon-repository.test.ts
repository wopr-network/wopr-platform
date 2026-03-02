import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { DrizzleTenantAddonRepository } from "./addon-repository.js";

describe("DrizzleTenantAddonRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleTenantAddonRepository;

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
    repo = new DrizzleTenantAddonRepository(db);
  });

  describe("list", () => {
    it("returns empty array for tenant with no addons", async () => {
      const result = await repo.list("t1");
      expect(result).toEqual([]);
    });

    it("returns addons for the correct tenant only", async () => {
      await repo.enable("t1", "gpu_acceleration");
      await repo.enable("t2", "custom_domain");
      const t1 = await repo.list("t1");
      expect(t1).toHaveLength(1);
      expect(t1[0].addonKey).toBe("gpu_acceleration");
      expect(t1[0].tenantId).toBe("t1");
      expect(t1[0].enabledAt).toBeInstanceOf(Date);
    });
  });

  describe("enable", () => {
    it("enables an addon for a tenant", async () => {
      await repo.enable("t1", "priority_queue");
      expect(await repo.isEnabled("t1", "priority_queue")).toBe(true);
    });

    it("is idempotent — enabling twice does not throw", async () => {
      await repo.enable("t1", "extra_storage");
      await repo.enable("t1", "extra_storage");
      const list = await repo.list("t1");
      expect(list).toHaveLength(1);
    });

    it("throws on unknown addon key", async () => {
      await expect(repo.enable("t1", "bogus" as never)).rejects.toThrow("Unknown addon key: bogus");
    });
  });

  describe("disable", () => {
    it("removes an enabled addon", async () => {
      await repo.enable("t1", "gpu_acceleration");
      await repo.disable("t1", "gpu_acceleration");
      expect(await repo.isEnabled("t1", "gpu_acceleration")).toBe(false);
    });

    it("is a no-op if addon was not enabled", async () => {
      await expect(repo.disable("t1", "gpu_acceleration")).resolves.toBeUndefined();
    });
  });

  describe("isEnabled", () => {
    it("returns false when addon is not enabled", async () => {
      expect(await repo.isEnabled("t1", "custom_domain")).toBe(false);
    });

    it("returns true when addon is enabled", async () => {
      await repo.enable("t1", "custom_domain");
      expect(await repo.isEnabled("t1", "custom_domain")).toBe(true);
    });
  });
});
