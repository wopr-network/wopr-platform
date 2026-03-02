import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzlePhoneNumberRepository } from "./drizzle-phone-number-repository.js";

describe("DrizzlePhoneNumberRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzlePhoneNumberRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzlePhoneNumberRepository(db);
  });

  describe("trackPhoneNumber", () => {
    it("inserts a new phone number record", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-abc", "+15551234567");
      const rows = await repo.listActivePhoneNumbers();
      expect(rows).toHaveLength(1);
      expect(rows[0].sid).toBe("PN-abc");
      expect(rows[0].tenantId).toBe("tenant-1");
      expect(rows[0].phoneNumber).toBe("+15551234567");
      expect(rows[0].provisionedAt).toBeDefined();
      expect(rows[0].lastBilledAt).toBeNull();
    });

    it("does not throw or duplicate on conflict (same sid)", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-dup", "+15551111111");
      await repo.trackPhoneNumber("tenant-2", "PN-dup", "+15552222222");
      const rows = await repo.listActivePhoneNumbers();
      expect(rows).toHaveLength(1);
      // First insert wins due to onConflictDoNothing
      expect(rows[0].tenantId).toBe("tenant-1");
      expect(rows[0].phoneNumber).toBe("+15551111111");
    });
  });

  describe("removePhoneNumber", () => {
    it("deletes the record matching the given sid", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-del", "+15551234567");
      await repo.trackPhoneNumber("tenant-1", "PN-keep", "+15559999999");
      await repo.removePhoneNumber("PN-del");
      const rows = await repo.listActivePhoneNumbers();
      expect(rows).toHaveLength(1);
      expect(rows[0].sid).toBe("PN-keep");
    });

    it("does not throw when sid does not exist", async () => {
      await expect(repo.removePhoneNumber("PN-nonexistent")).resolves.toBeUndefined();
    });
  });

  describe("listActivePhoneNumbers", () => {
    it("returns empty array when no numbers exist", async () => {
      const rows = await repo.listActivePhoneNumbers();
      expect(rows).toEqual([]);
    });

    it("returns all numbers across tenants", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-1", "+15551111111");
      await repo.trackPhoneNumber("tenant-2", "PN-2", "+15552222222");
      await repo.trackPhoneNumber("tenant-1", "PN-3", "+15553333333");
      const rows = await repo.listActivePhoneNumbers();
      expect(rows).toHaveLength(3);
      const sids = rows.map((r) => r.sid).sort();
      expect(sids).toEqual(["PN-1", "PN-2", "PN-3"]);
    });

    it("returns domain objects with correct shape", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-shape", "+15550000000");
      const rows = await repo.listActivePhoneNumbers();
      expect(rows[0]).toEqual({
        sid: "PN-shape",
        tenantId: "tenant-1",
        phoneNumber: "+15550000000",
        provisionedAt: expect.any(String),
        lastBilledAt: null,
      });
    });
  });

  describe("listByTenant", () => {
    it("returns only numbers belonging to the specified tenant", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-a", "+15551111111");
      await repo.trackPhoneNumber("tenant-2", "PN-b", "+15552222222");
      await repo.trackPhoneNumber("tenant-1", "PN-c", "+15553333333");
      const rows = await repo.listByTenant("tenant-1");
      expect(rows).toHaveLength(2);
      const sids = rows.map((r) => r.sid).sort();
      expect(sids).toEqual(["PN-a", "PN-c"]);
    });

    it("returns empty array when tenant has no numbers", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-x", "+15551111111");
      const rows = await repo.listByTenant("tenant-other");
      expect(rows).toEqual([]);
    });
  });

  describe("markBilled", () => {
    it("sets lastBilledAt to a non-null timestamp", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-bill", "+15551234567");

      // Confirm lastBilledAt starts as null
      let rows = await repo.listActivePhoneNumbers();
      expect(rows[0].lastBilledAt).toBeNull();

      await repo.markBilled("PN-bill");

      rows = await repo.listActivePhoneNumbers();
      expect(rows[0].lastBilledAt).not.toBeNull();
      expect(typeof rows[0].lastBilledAt).toBe("string");
    });

    it("does not affect other phone numbers", async () => {
      await repo.trackPhoneNumber("tenant-1", "PN-billed", "+15551111111");
      await repo.trackPhoneNumber("tenant-1", "PN-unbilled", "+15552222222");
      await repo.markBilled("PN-billed");
      const rows = await repo.listActivePhoneNumbers();
      const billed = rows.find((r) => r.sid === "PN-billed");
      const unbilled = rows.find((r) => r.sid === "PN-unbilled");
      expect(billed?.lastBilledAt).not.toBeNull();
      expect(unbilled?.lastBilledAt).toBeNull();
    });
  });
});
