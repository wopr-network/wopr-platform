/**
 * Unit tests for PayRamChargeStore (WOP-407).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test/db.js";
import { PayRamChargeStore } from "./charge-store.js";

describe("PayRamChargeStore", () => {
  let pool: PGlite;
  let store: PayRamChargeStore;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    store = new PayRamChargeStore(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("create() stores a charge", async () => {
    await store.create("ref-001", "tenant-1", 2500);

    const charge = await store.getByReferenceId("ref-001");
    expect(charge).not.toBeNull();
    expect(charge?.referenceId).toBe("ref-001");
    expect(charge?.tenantId).toBe("tenant-1");
    expect(charge?.amountUsdCents).toBe(2500);
    expect(charge?.status).toBe("OPEN");
    expect(charge?.creditedAt).toBeNull();
  });

  it("getByReferenceId() returns null when not found", async () => {
    const charge = await store.getByReferenceId("ref-nonexistent");
    expect(charge).toBeNull();
  });

  it("updateStatus() updates status, currency and filled_amount", async () => {
    await store.create("ref-002", "tenant-2", 5000);
    await store.updateStatus("ref-002", "FILLED", "USDC", "50.00");

    const charge = await store.getByReferenceId("ref-002");
    expect(charge?.status).toBe("FILLED");
    expect(charge?.currency).toBe("USDC");
    expect(charge?.filledAmount).toBe("50.00");
  });

  it("updateStatus() handles partial updates (no currency)", async () => {
    await store.create("ref-003", "tenant-3", 1000);
    await store.updateStatus("ref-003", "VERIFYING");

    const charge = await store.getByReferenceId("ref-003");
    expect(charge?.status).toBe("VERIFYING");
    expect(charge?.currency).toBeNull();
  });

  it("isCredited() returns false before markCredited", async () => {
    await store.create("ref-004", "tenant-4", 1500);
    expect(await store.isCredited("ref-004")).toBe(false);
  });

  it("markCredited() sets creditedAt", async () => {
    await store.create("ref-005", "tenant-5", 3000);
    await store.markCredited("ref-005");

    const charge = await store.getByReferenceId("ref-005");
    expect(charge?.creditedAt).not.toBeNull();
  });

  it("isCredited() returns true after markCredited", async () => {
    await store.create("ref-006", "tenant-6", 2000);
    await store.markCredited("ref-006");
    expect(await store.isCredited("ref-006")).toBe(true);
  });
});
