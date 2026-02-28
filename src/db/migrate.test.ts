import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";

// TOP OF FILE - shared across ALL describes
let pool: PGlite;

beforeAll(async () => {
  ({ pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("runMigrations", () => {
  it("applies all migrations to a fresh database", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const tableNames = result.rows.map((r) => r.table_name);
    expect(tableNames).toContain("bot_instances");
    expect(tableNames).toContain("nodes");
  });

  it("is idempotent — createTestDb can be called twice without error", async () => {
    // Calling createTestDb a second time to verify idempotency
    const { pool: pool2 } = await createTestDb();
    await pool2.close();
  });
});
