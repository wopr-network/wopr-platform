import type { PGlite } from "@electric-sql/pglite";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import type { ITwoFactorRepository } from "@wopr-network/platform-core/security/two-factor-repository";
import { DrizzleTwoFactorRepository } from "@wopr-network/platform-core/security/two-factor-repository";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("DrizzleTwoFactorRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: ITwoFactorRepository;

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
    repo = new DrizzleTwoFactorRepository(db);
  });

  describe("getMandateStatus", () => {
    it("returns false when no row exists for tenant", async () => {
      const result = await repo.getMandateStatus("nonexistent-tenant");
      expect(result).toEqual({
        tenantId: "nonexistent-tenant",
        requireTwoFactor: false,
      });
    });

    it("returns stored mandate status after set", async () => {
      await repo.setMandateStatus("tenant-1", true);
      const result = await repo.getMandateStatus("tenant-1");
      expect(result).toEqual({
        tenantId: "tenant-1",
        requireTwoFactor: true,
      });
    });

    it("returns correct status for each tenant independently", async () => {
      await repo.setMandateStatus("tenant-a", true);
      await repo.setMandateStatus("tenant-b", false);

      const a = await repo.getMandateStatus("tenant-a");
      const b = await repo.getMandateStatus("tenant-b");

      expect(a.requireTwoFactor).toBe(true);
      expect(b.requireTwoFactor).toBe(false);
    });
  });

  describe("setMandateStatus", () => {
    it("creates a new row and returns the status", async () => {
      const result = await repo.setMandateStatus("tenant-new", true);
      expect(result).toEqual({
        tenantId: "tenant-new",
        requireTwoFactor: true,
      });
    });

    it("upserts on conflict — second call overwrites first", async () => {
      await repo.setMandateStatus("tenant-x", true);
      const result = await repo.setMandateStatus("tenant-x", false);
      expect(result.requireTwoFactor).toBe(false);

      // Verify via read
      const read = await repo.getMandateStatus("tenant-x");
      expect(read.requireTwoFactor).toBe(false);
    });

    it("can re-enable after disabling", async () => {
      await repo.setMandateStatus("tenant-y", true);
      await repo.setMandateStatus("tenant-y", false);
      await repo.setMandateStatus("tenant-y", true);

      const result = await repo.getMandateStatus("tenant-y");
      expect(result.requireTwoFactor).toBe(true);
    });

    it("handles setting false on a nonexistent tenant (insert with false)", async () => {
      const result = await repo.setMandateStatus("tenant-z", false);
      expect(result).toEqual({
        tenantId: "tenant-z",
        requireTwoFactor: false,
      });
    });
  });
});
