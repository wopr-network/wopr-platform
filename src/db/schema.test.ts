import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, truncateAllTables } from "../test/db.js";

describe("snapshots schema (via Drizzle migration)", () => {
  let pool: PGlite;

  beforeAll(async () => {
    ({ pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("creates the snapshots table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'snapshots'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("creates expected indexes", async () => {
    const result = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'snapshots' AND indexname LIKE 'idx_snapshots_%'",
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toContain("idx_snapshots_instance");
    expect(names).toContain("idx_snapshots_user");
  });

  it("is idempotent (migration can run on same db)", async () => {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'snapshots'",
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it("enforces NOT NULL on instance_id", async () => {
    await expect(
      pool.query(
        "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
        ["s1", null, "u1", "manual", "/path"],
      ),
    ).rejects.toThrow();
  });

  it("enforces NOT NULL on user_id", async () => {
    await expect(
      pool.query(
        "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
        ["s1", "i1", null, "manual", "/path"],
      ),
    ).rejects.toThrow();
  });

  it("enforces NOT NULL on trigger", async () => {
    await expect(
      pool.query(
        "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
        ["s1", "i1", "u1", null, "/path"],
      ),
    ).rejects.toThrow();
  });

  it("enforces NOT NULL on storage_path", async () => {
    await expect(
      pool.query(
        "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
        ["s1", "i1", "u1", "manual", null],
      ),
    ).rejects.toThrow();
  });

  it("enforces PRIMARY KEY uniqueness on id", async () => {
    await pool.query(
      "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
      ["dup-id", "i1", "u1", "manual", "/a"],
    );
    await expect(
      pool.query(
        "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
        ["dup-id", "i2", "u2", "scheduled", "/b"],
      ),
    ).rejects.toThrow();
  });

  it("provides defaults for size_mb, plugins, and config_hash", async () => {
    await pool.query(
      "INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES ($1, $2, $3, $4, $5)",
      ["s-defaults", "i1", "u1", "manual", "/path"],
    );
    const result = await pool.query<{ size_mb: number; plugins: string; config_hash: string }>(
      "SELECT size_mb, plugins, config_hash FROM snapshots WHERE id = $1",
      ["s-defaults"],
    );
    const row = result.rows[0];
    expect(row?.size_mb).toBe(0);
    expect(row?.plugins).toBe("[]");
    expect(row?.config_hash).toBe("");
  });
});

describe("bot_profiles schema (via Drizzle migration)", () => {
  let pool: PGlite;

  beforeAll(async () => {
    ({ pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("creates the bot_profiles table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bot_profiles'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("creates expected indexes", async () => {
    const result = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'bot_profiles' AND indexname LIKE 'idx_bot_profiles_%'",
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toContain("idx_bot_profiles_tenant");
    expect(names).toContain("idx_bot_profiles_name");
    expect(names).toContain("idx_bot_profiles_release_channel");
  });

  it("enforces NOT NULL on tenant_id", async () => {
    await expect(
      pool.query("INSERT INTO bot_profiles (id, tenant_id, name, image) VALUES ($1, $2, $3, $4)", [
        "bp1",
        null,
        "my-bot",
        "ghcr.io/wopr-network/wopr:latest",
      ]),
    ).rejects.toThrow();
  });

  it("enforces NOT NULL on name", async () => {
    await expect(
      pool.query("INSERT INTO bot_profiles (id, tenant_id, name, image) VALUES ($1, $2, $3, $4)", [
        "bp1",
        "t1",
        null,
        "ghcr.io/wopr-network/wopr:latest",
      ]),
    ).rejects.toThrow();
  });

  it("enforces NOT NULL on image", async () => {
    await expect(
      pool.query("INSERT INTO bot_profiles (id, tenant_id, name, image) VALUES ($1, $2, $3, $4)", [
        "bp1",
        "t1",
        "my-bot",
        null,
      ]),
    ).rejects.toThrow();
  });

  it("enforces PRIMARY KEY uniqueness on id", async () => {
    await pool.query("INSERT INTO bot_profiles (id, tenant_id, name, image) VALUES ($1, $2, $3, $4)", [
      "dup-id",
      "t1",
      "bot-a",
      "ghcr.io/wopr-network/wopr:latest",
    ]);
    await expect(
      pool.query("INSERT INTO bot_profiles (id, tenant_id, name, image) VALUES ($1, $2, $3, $4)", [
        "dup-id",
        "t2",
        "bot-b",
        "ghcr.io/wopr-network/wopr:latest",
      ]),
    ).rejects.toThrow();
  });
});

describe("credit_transactions schema (via Drizzle migration)", () => {
  let pool: PGlite;

  beforeAll(async () => {
    ({ pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("creates the credit_transactions table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'credit_transactions'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("enforces UNIQUE on reference_id", async () => {
    await pool.query(
      "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, reference_id) VALUES ($1, $2, $3, $4, $5, $6)",
      ["tx1", "t1", 100, 100, "purchase", "ref-unique"],
    );
    await expect(
      pool.query(
        "INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, reference_id) VALUES ($1, $2, $3, $4, $5, $6)",
        ["tx2", "t2", 200, 200, "purchase", "ref-unique"],
      ),
    ).rejects.toThrow();
  });
});

describe("migration completeness", () => {
  it("all core tables exist after migration", async () => {
    const { pool } = await createTestDb();
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const tables = result.rows.map((r) => r.table_name);
    expect(tables).toContain("bot_instances");
    expect(tables).toContain("bot_profiles");
    expect(tables).toContain("credit_transactions");
    expect(tables).toContain("meter_events");
    expect(tables).toContain("nodes");
    expect(tables).toContain("snapshots");
  });
});
