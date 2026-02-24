import BetterSqlite3 from "better-sqlite3";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Credit } from "../monetization/credit.js";
import { creditColumn } from "./credit-column.js";
import { createDb, type DrizzleDb } from "./index.js";

// Test-only table using the custom column
const testTable = sqliteTable("test_credits", {
  id: text("id").primaryKey(),
  amount: creditColumn("amount").notNull(),
});

describe("creditColumn", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    sqlite.exec(`
      CREATE TABLE test_credits (
        id TEXT PRIMARY KEY,
        amount INTEGER NOT NULL
      )
    `);
    db = createDb(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("stores Credit as integer and reads back as Credit", () => {
    const credit = Credit.fromDollars(1.5);
    db.insert(testTable).values({ id: "t1", amount: credit }).run();
    const row = db.select().from(testTable).where(eq(testTable.id, "t1")).get();
    expect(row).toBeDefined();
    expect(row?.amount).toBeInstanceOf(Credit);
    expect(row?.amount.toRaw()).toBe(credit.toRaw());
  });

  it("stores raw integer in SQLite", () => {
    const credit = Credit.fromDollars(0.5);
    db.insert(testTable).values({ id: "t2", amount: credit }).run();
    const raw = sqlite.prepare("SELECT amount FROM test_credits WHERE id = 't2'").get() as { amount: number };
    expect(raw.amount).toBe(500_000);
  });

  it("round-trips Credit.ZERO", () => {
    db.insert(testTable).values({ id: "t3", amount: Credit.ZERO }).run();
    const row = db.select().from(testTable).where(eq(testTable.id, "t3")).get();
    expect(row?.amount.isZero()).toBe(true);
  });

  it("round-trips sub-cent precision", () => {
    const credit = Credit.fromDollars(0.001); // 1000 raw
    db.insert(testTable).values({ id: "t4", amount: credit }).run();
    const row = db.select().from(testTable).where(eq(testTable.id, "t4")).get();
    expect(row?.amount.toRaw()).toBe(1_000);
    expect(row?.amount.isZero()).toBe(false);
  });

  it("round-trips negative credit", () => {
    const credit = Credit.fromRaw(-500_000);
    db.insert(testTable).values({ id: "t5", amount: credit }).run();
    const row = db.select().from(testTable).where(eq(testTable.id, "t5")).get();
    expect(row?.amount.toRaw()).toBe(-500_000);
    expect(row?.amount.isNegative()).toBe(true);
  });
});
