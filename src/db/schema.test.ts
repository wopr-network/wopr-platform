import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, truncateAllTables } from "../test/db.js";

// TOP OF FILE - shared across ALL describes
let pool: PGlite;

beforeAll(async () => {
  ({ pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("snapshots schema (via Drizzle migration)", () => {
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
      "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, reference_id) VALUES ($1, $2, $3, $4, $5, $6)",
      ["tx1", "t1", 1000000000, 1000000000, "purchase", "ref-unique"],
    );
    await expect(
      pool.query(
        "INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, reference_id) VALUES ($1, $2, $3, $4, $5, $6)",
        ["tx2", "t2", 2000000000, 2000000000, "purchase", "ref-unique"],
      ),
    ).rejects.toThrow();
  });
});

describe("gateway tables schema (via Drizzle migration)", () => {
  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("creates the gateway_metrics table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'gateway_metrics'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("creates expected indexes on gateway_metrics", async () => {
    const result = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'gateway_metrics'",
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toContain("idx_gateway_metrics_unique");
    expect(names).toContain("idx_gateway_metrics_minute");
  });

  it("enforces UNIQUE on (minute_key, capability) in gateway_metrics", async () => {
    await pool.query(
      "INSERT INTO gateway_metrics (minute_key, capability, requests, errors, credit_failures) VALUES ($1, $2, $3, $4, $5)",
      [1000, "tts", 1, 0, 0],
    );
    await expect(
      pool.query(
        "INSERT INTO gateway_metrics (minute_key, capability, requests, errors, credit_failures) VALUES ($1, $2, $3, $4, $5)",
        [1000, "tts", 2, 0, 0],
      ),
    ).rejects.toThrow();
  });

  it("creates the circuit_breaker_states table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'circuit_breaker_states'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("enforces PRIMARY KEY on instance_id in circuit_breaker_states", async () => {
    await pool.query("INSERT INTO circuit_breaker_states (instance_id, count, window_start) VALUES ($1, $2, $3)", [
      "inst-1",
      0,
      1000,
    ]);
    await expect(
      pool.query("INSERT INTO circuit_breaker_states (instance_id, count, window_start) VALUES ($1, $2, $3)", [
        "inst-1",
        1,
        2000,
      ]),
    ).rejects.toThrow();
  });

  it("creates the rate_limit_entries table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'rate_limit_entries'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("enforces composite PRIMARY KEY on (key, scope) in rate_limit_entries", async () => {
    await pool.query("INSERT INTO rate_limit_entries (key, scope, count, window_start) VALUES ($1, $2, $3, $4)", [
      "user-1",
      "global",
      5,
      1000,
    ]);
    await expect(
      pool.query("INSERT INTO rate_limit_entries (key, scope, count, window_start) VALUES ($1, $2, $3, $4)", [
        "user-1",
        "global",
        6,
        1000,
      ]),
    ).rejects.toThrow();
  });
});

describe("chat-backend tables schema (via Drizzle migration)", () => {
  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("creates the session_usage table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'session_usage'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("creates expected indexes on session_usage", async () => {
    const result = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'session_usage'",
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toContain("idx_session_usage_session");
    expect(names).toContain("idx_session_usage_user");
    expect(names).toContain("idx_session_usage_created");
  });

  it("enforces NOT NULL on model and created_at in session_usage", async () => {
    await expect(
      pool.query("INSERT INTO session_usage (id, session_id, model, created_at) VALUES ($1, $2, $3, $4)", [
        "su1",
        "sess-1",
        null,
        1000,
      ]),
    ).rejects.toThrow();
  });

  it("creates the onboarding_sessions table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'onboarding_sessions'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("enforces UNIQUE on wopr_session_name in onboarding_sessions", async () => {
    await pool.query(
      "INSERT INTO onboarding_sessions (id, wopr_session_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
      ["os1", "session-abc", "active", 1000, 1000],
    );
    await expect(
      pool.query(
        "INSERT INTO onboarding_sessions (id, wopr_session_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
        ["os2", "session-abc", "active", 1001, 1001],
      ),
    ).rejects.toThrow();
  });

  it("creates the setup_sessions table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'setup_sessions'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("enforces UNIQUE on (session_id, status) in setup_sessions", async () => {
    await pool.query(
      "INSERT INTO setup_sessions (id, session_id, plugin_id, status, started_at) VALUES ($1, $2, $3, $4, $5)",
      ["ss1", "sess-1", "plugin-discord", "in_progress", 1000],
    );
    await expect(
      pool.query(
        "INSERT INTO setup_sessions (id, session_id, plugin_id, status, started_at) VALUES ($1, $2, $3, $4, $5)",
        ["ss2", "sess-1", "plugin-discord", "in_progress", 1001],
      ),
    ).rejects.toThrow();
  });
});

describe("credential-vault tables schema (via Drizzle migration)", () => {
  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("creates the provider_credentials table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'provider_credentials'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("creates expected indexes on provider_credentials", async () => {
    const result = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'provider_credentials'",
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toContain("idx_provider_creds_provider");
    expect(names).toContain("idx_provider_creds_active");
    expect(names).toContain("idx_provider_creds_created_by");
  });

  it("enforces NOT NULL on provider in provider_credentials", async () => {
    await expect(
      pool.query(
        "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        ["cred-1", null, "Prod Key", "enc-data", "header", "admin"],
      ),
    ).rejects.toThrow();
  });

  it("enforces PRIMARY KEY uniqueness on id in provider_credentials", async () => {
    await pool.query(
      "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      ["cred-dup", "anthropic", "Key 1", "enc-data-1", "header", "admin"],
    );
    await expect(
      pool.query(
        "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        ["cred-dup", "openai", "Key 2", "enc-data-2", "bearer", "admin"],
      ),
    ).rejects.toThrow();
  });

  it("defaults is_active to true in provider_credentials", async () => {
    await pool.query(
      "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      ["cred-default", "anthropic", "Default Key", "enc-data", "header", "admin"],
    );
    const result = await pool.query<{ is_active: boolean }>(
      "SELECT is_active FROM provider_credentials WHERE id = $1",
      ["cred-default"],
    );
    expect(result.rows[0]?.is_active).toBe(true);
  });
});

describe("migration completeness", () => {
  it("all core tables exist after migration", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const tables = result.rows.map((r) => r.table_name);
    expect(tables).toContain("bot_instances");
    expect(tables).toContain("bot_profiles");
    expect(tables).toContain("circuit_breaker_states");
    expect(tables).toContain("credit_transactions");
    expect(tables).toContain("gateway_metrics");
    expect(tables).toContain("meter_events");
    expect(tables).toContain("nodes");
    expect(tables).toContain("onboarding_sessions");
    expect(tables).toContain("provider_credentials");
    expect(tables).toContain("rate_limit_entries");
    expect(tables).toContain("session_usage");
    expect(tables).toContain("setup_sessions");
    expect(tables).toContain("snapshots");
  });
});
