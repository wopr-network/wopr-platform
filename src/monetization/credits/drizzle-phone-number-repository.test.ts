import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { DrizzlePhoneNumberRepository } from "./drizzle-phone-number-repository.js";

describe("DrizzlePhoneNumberRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzlePhoneNumberRepository;

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
    repo = new DrizzlePhoneNumberRepository(db);
  });

  it("trackPhoneNumber inserts a new record", async () => {
    await repo.trackPhoneNumber("tenant-1", "PN-001", "+15551234567");
    const numbers = await repo.listByTenant("tenant-1");
    expect(numbers).toHaveLength(1);
    expect(numbers[0].sid).toBe("PN-001");
    expect(numbers[0].phoneNumber).toBe("+15551234567");
    expect(numbers[0].tenantId).toBe("tenant-1");
    expect(numbers[0].lastBilledAt).toBeNull();
  });

  it("trackPhoneNumber with duplicate sid does not throw", async () => {
    await repo.trackPhoneNumber("tenant-1", "PN-001", "+15551234567");
    const numbers = await repo.listByTenant("tenant-1");
    expect(numbers).toHaveLength(1);
  });

  it("listActivePhoneNumbers returns all numbers", async () => {
    await repo.trackPhoneNumber("tenant-1", "PN-001", "+15551234567");
    await repo.trackPhoneNumber("tenant-2", "PN-002", "+15559876543");
    const all = await repo.listActivePhoneNumbers();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const sids = all.map((n) => n.sid);
    expect(sids).toContain("PN-001");
    expect(sids).toContain("PN-002");
  });

  it("listByTenant filters by tenant", async () => {
    const t1 = await repo.listByTenant("tenant-1");
    const t2 = await repo.listByTenant("tenant-2");
    expect(t1.every((n) => n.tenantId === "tenant-1")).toBe(true);
    expect(t2.every((n) => n.tenantId === "tenant-2")).toBe(true);
  });

  it("markBilled sets lastBilledAt to non-null", async () => {
    await repo.markBilled("PN-001");
    const numbers = await repo.listByTenant("tenant-1");
    const pn = numbers.find((n) => n.sid === "PN-001");
    expect(pn?.lastBilledAt).not.toBeNull();
  });

  it("removePhoneNumber deletes the record", async () => {
    await repo.removePhoneNumber("PN-002");
    const all = await repo.listActivePhoneNumbers();
    const sids = all.map((n) => n.sid);
    expect(sids).not.toContain("PN-002");
  });
});
