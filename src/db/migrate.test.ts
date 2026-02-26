import { describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";

describe("runMigrations", () => {
  it("applies all migrations to a fresh database", async () => {
    const { pool } = await createTestDb();
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const tableNames = result.rows.map((r) => r.table_name);
    expect(tableNames).toContain("bot_instances");
    expect(tableNames).toContain("nodes");
  });

  it("is idempotent — createTestDb can be called twice without error", async () => {
    await createTestDb();
    await createTestDb();
  });
});
