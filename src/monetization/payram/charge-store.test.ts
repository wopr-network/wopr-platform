/**
 * Unit tests for PayRamChargeStore (WOP-407).
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/index.js";
import { PayRamChargeStore } from "./charge-store.js";
import { initPayRamSchema } from "./schema.js";

describe("PayRamChargeStore", () => {
  let sqlite: BetterSqlite3.Database;
  let store: PayRamChargeStore;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initPayRamSchema(sqlite);
    const db = createDb(sqlite);
    store = new PayRamChargeStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("create() stores a charge", () => {
    store.create("ref-001", "tenant-1", 2500);

    const charge = store.getByReferenceId("ref-001");
    expect(charge).not.toBeNull();
    expect(charge?.referenceId).toBe("ref-001");
    expect(charge?.tenantId).toBe("tenant-1");
    expect(charge?.amountUsdCents).toBe(2500);
    expect(charge?.status).toBe("OPEN");
    expect(charge?.creditedAt).toBeNull();
  });

  it("getByReferenceId() returns null when not found", () => {
    const charge = store.getByReferenceId("ref-nonexistent");
    expect(charge).toBeNull();
  });

  it("updateStatus() updates status, currency and filled_amount", () => {
    store.create("ref-002", "tenant-2", 5000);
    store.updateStatus("ref-002", "FILLED", "USDC", "50.00");

    const charge = store.getByReferenceId("ref-002");
    expect(charge?.status).toBe("FILLED");
    expect(charge?.currency).toBe("USDC");
    expect(charge?.filledAmount).toBe("50.00");
  });

  it("updateStatus() handles partial updates (no currency)", () => {
    store.create("ref-003", "tenant-3", 1000);
    store.updateStatus("ref-003", "VERIFYING");

    const charge = store.getByReferenceId("ref-003");
    expect(charge?.status).toBe("VERIFYING");
    expect(charge?.currency).toBeNull();
  });

  it("isCredited() returns false before markCredited", () => {
    store.create("ref-004", "tenant-4", 1500);
    expect(store.isCredited("ref-004")).toBe(false);
  });

  it("markCredited() sets creditedAt", () => {
    store.create("ref-005", "tenant-5", 3000);
    store.markCredited("ref-005");

    const charge = store.getByReferenceId("ref-005");
    expect(charge?.creditedAt).not.toBeNull();
  });

  it("isCredited() returns true after markCredited", () => {
    store.create("ref-006", "tenant-6", 2000);
    store.markCredited("ref-006");
    expect(store.isCredited("ref-006")).toBe(true);
  });
});
