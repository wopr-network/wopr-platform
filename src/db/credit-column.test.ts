import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import { Credit } from "../monetization/credit.js";
import { createTestDb } from "../test/db.js";
import { creditColumn } from "./credit-column.js";
import type { DrizzleDb } from "./index.js";

const testTable = pgTable("test_credits", {
  id: text("id").primaryKey(),
  amount: creditColumn("amount").notNull(),
});

describe("creditColumn", () => {
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_credits (
        id TEXT PRIMARY KEY,
        amount INTEGER NOT NULL
      )
    `);
  });

  it("stores Credit as integer and reads back as Credit", async () => {
    const credit = Credit.fromDollars(1.5);
    await db.insert(testTable).values({ id: "t1", amount: credit });
    const rows = await db.select().from(testTable).where(eq(testTable.id, "t1"));
    expect(rows[0]).toBeDefined();
    expect(rows[0]?.amount).toBeInstanceOf(Credit);
    expect(rows[0]?.amount.toRaw()).toBe(credit.toRaw());
  });

  it("stores raw integer in pg", async () => {
    const credit = Credit.fromDollars(0.5);
    await db.insert(testTable).values({ id: "t2", amount: credit });
    const result = await pool.query<{ amount: number }>("SELECT amount FROM test_credits WHERE id = $1", ["t2"]);
    expect(result.rows[0]?.amount).toBe(500_000);
  });

  it("round-trips Credit.ZERO", async () => {
    await db.insert(testTable).values({ id: "t3", amount: Credit.ZERO });
    const rows = await db.select().from(testTable).where(eq(testTable.id, "t3"));
    expect(rows[0]?.amount.isZero()).toBe(true);
  });

  it("round-trips sub-cent precision", async () => {
    const credit = Credit.fromDollars(0.001);
    await db.insert(testTable).values({ id: "t4", amount: credit });
    const rows = await db.select().from(testTable).where(eq(testTable.id, "t4"));
    expect(rows[0]?.amount.toRaw()).toBe(1_000);
    expect(rows[0]?.amount.isZero()).toBe(false);
  });

  it("round-trips negative credit", async () => {
    const credit = Credit.fromRaw(-500_000);
    await db.insert(testTable).values({ id: "t5", amount: credit });
    const rows = await db.select().from(testTable).where(eq(testTable.id, "t5"));
    expect(rows[0]?.amount.toRaw()).toBe(-500_000);
    expect(rows[0]?.amount.isNegative()).toBe(true);
  });
});
