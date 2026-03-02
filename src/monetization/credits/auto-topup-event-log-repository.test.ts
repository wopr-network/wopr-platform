import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopup } from "../../db/schema/credit-auto-topup.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleAutoTopupEventLogRepository } from "./auto-topup-event-log-repository.js";

describe("DrizzleAutoTopupEventLogRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleAutoTopupEventLogRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleAutoTopupEventLogRepository(db);
  });

  it("writes a success event with all fields", async () => {
    await repo.writeEvent({
      tenantId: "t1",
      amountCents: 500,
      status: "success",
      failureReason: null,
      paymentReference: "pi_abc123",
    });

    const rows = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, "t1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("t1");
    expect(rows[0].amountCents).toBe(500);
    expect(rows[0].status).toBe("success");
    expect(rows[0].failureReason).toBeNull();
    expect(rows[0].paymentReference).toBe("pi_abc123");
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].createdAt).toBeTruthy();
  });

  it("writes a failed event with failure reason", async () => {
    await repo.writeEvent({
      tenantId: "t1",
      amountCents: 1000,
      status: "failed",
      failureReason: "card_declined",
      paymentReference: null,
    });

    const rows = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, "t1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].failureReason).toBe("card_declined");
    expect(rows[0].paymentReference).toBeNull();
  });

  it("defaults optional fields to null when omitted", async () => {
    await repo.writeEvent({
      tenantId: "t1",
      amountCents: 200,
      status: "success",
    });

    const rows = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, "t1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].failureReason).toBeNull();
    expect(rows[0].paymentReference).toBeNull();
  });

  it("generates unique ids for each event", async () => {
    await repo.writeEvent({ tenantId: "t1", amountCents: 100, status: "success" });
    await repo.writeEvent({ tenantId: "t1", amountCents: 200, status: "success" });

    const rows = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, "t1"));
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it("isolates events by tenant", async () => {
    await repo.writeEvent({ tenantId: "t1", amountCents: 100, status: "success" });
    await repo.writeEvent({ tenantId: "t2", amountCents: 200, status: "failed", failureReason: "insufficient_funds" });

    const t1Rows = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, "t1"));
    const t2Rows = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, "t2"));
    expect(t1Rows).toHaveLength(1);
    expect(t1Rows[0].amountCents).toBe(100);
    expect(t2Rows).toHaveLength(1);
    expect(t2Rows[0].amountCents).toBe(200);
    expect(t2Rows[0].failureReason).toBe("insufficient_funds");
  });
});
