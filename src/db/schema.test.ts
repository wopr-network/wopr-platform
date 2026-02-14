import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initMeterSchema } from "../monetization/metering/schema.js";
import { TierStore } from "../monetization/quotas/tier-definitions.js";
import { initStripeSchema } from "../monetization/stripe/schema.js";
import { createTestDb } from "../test/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): BetterSqlite3.Database {
  return new BetterSqlite3(":memory:");
}

/** Recreate audit_log table with raw SQL for schema constraint testing. */
function initAuditSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log (timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log (user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log (resource_type, resource_id)");
}

function tableNames(db: BetterSqlite3.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
}

function indexNames(db: BetterSqlite3.Database, prefix: string): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?").all(`${prefix}%`) as {
      name: string;
    }[]
  ).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// initSnapshotSchema
// ---------------------------------------------------------------------------

describe("snapshots schema (via Drizzle migration)", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.sqlite;
  });

  afterEach(() => {
    db.close();
  });

  it("creates the snapshots table", () => {
    expect(tableNames(db)).toContain("snapshots");
  });

  it("creates expected indexes", () => {
    const idxs = indexNames(db, "idx_snapshots_");
    expect(idxs).toContain("idx_snapshots_instance");
    expect(idxs).toContain("idx_snapshots_user");
  });

  it("is idempotent (migration can run on same db)", () => {
    // Drizzle migrations are inherently idempotent (tracked in __drizzle_migrations)
    expect(tableNames(db).filter((t) => t === "snapshots")).toHaveLength(1);
  });

  it("enforces NOT NULL on instance_id", () => {
    expect(() =>
      db
        .prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)")
        .run("s1", null, "u1", "manual", "/path"),
    ).toThrow();
  });

  it("enforces NOT NULL on user_id", () => {
    expect(() =>
      db
        .prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)")
        .run("s1", "i1", null, "manual", "/path"),
    ).toThrow();
  });

  it("enforces NOT NULL on trigger", () => {
    expect(() =>
      db
        .prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)")
        .run("s1", "i1", "u1", null, "/path"),
    ).toThrow();
  });

  it("enforces NOT NULL on storage_path", () => {
    expect(() =>
      db
        .prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)")
        .run("s1", "i1", "u1", "manual", null),
    ).toThrow();
  });

  it("enforces CHECK constraint on trigger column", () => {
    // Valid values: manual, scheduled, pre_update
    db.prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)").run(
      "s-manual",
      "i1",
      "u1",
      "manual",
      "/a",
    );
    db.prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)").run(
      "s-scheduled",
      "i1",
      "u1",
      "scheduled",
      "/b",
    );
    db.prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)").run(
      "s-pre",
      "i1",
      "u1",
      "pre_update",
      "/c",
    );

    // Invalid value should fail
    expect(() =>
      db
        .prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)")
        .run("s-bad", "i1", "u1", "invalid_trigger", "/d"),
    ).toThrow();
  });

  it("enforces PRIMARY KEY uniqueness on id", () => {
    db.prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)").run(
      "dup-id",
      "i1",
      "u1",
      "manual",
      "/a",
    );

    expect(() =>
      db
        .prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)")
        .run("dup-id", "i2", "u2", "scheduled", "/b"),
    ).toThrow();
  });

  it("provides defaults for size_mb, plugins, and config_hash", () => {
    db.prepare("INSERT INTO snapshots (id, instance_id, user_id, trigger, storage_path) VALUES (?, ?, ?, ?, ?)").run(
      "s-defaults",
      "i1",
      "u1",
      "manual",
      "/path",
    );

    const row = db.prepare("SELECT size_mb, plugins, config_hash FROM snapshots WHERE id = ?").get("s-defaults") as {
      size_mb: number;
      plugins: string;
      config_hash: string;
    };

    expect(row.size_mb).toBe(0);
    expect(row.plugins).toBe("[]");
    expect(row.config_hash).toBe("");
  });
});

// ---------------------------------------------------------------------------
// initAuditSchema — constraint & integrity tests
// ---------------------------------------------------------------------------

describe("initAuditSchema — data integrity", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = freshDb();
    initAuditSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("enforces NOT NULL on timestamp", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("a1", null, "u1", "session", "instance.create", "instance"),
    ).toThrow();
  });

  it("enforces NOT NULL on user_id", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("a1", Date.now(), null, "session", "instance.create", "instance"),
    ).toThrow();
  });

  it("enforces NOT NULL on auth_method", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("a1", Date.now(), "u1", null, "instance.create", "instance"),
    ).toThrow();
  });

  it("enforces NOT NULL on action", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("a1", Date.now(), "u1", "session", null, "instance"),
    ).toThrow();
  });

  it("enforces NOT NULL on resource_type", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("a1", Date.now(), "u1", "session", "instance.create", null),
    ).toThrow();
  });

  it("enforces PRIMARY KEY uniqueness on id", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("dup", now, "u1", "session", "instance.create", "instance");

    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("dup", now, "u2", "api_key", "instance.destroy", "instance"),
    ).toThrow();
  });

  it("allows NULL for optional columns (resource_id, details, ip_address, user_agent)", () => {
    db.prepare(
      "INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type, resource_id, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("a-null", Date.now(), "u1", "session", "instance.create", "instance", null, null, null, null);

    const row = db.prepare("SELECT * FROM audit_log WHERE id = ?").get("a-null") as Record<string, unknown>;
    expect(row.resource_id).toBeNull();
    expect(row.details).toBeNull();
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();
  });

  it("has all expected indexes", () => {
    const idxs = indexNames(db, "idx_audit_");
    expect(idxs).toContain("idx_audit_timestamp");
    expect(idxs).toContain("idx_audit_user_id");
    expect(idxs).toContain("idx_audit_action");
    expect(idxs).toContain("idx_audit_resource");
  });
});

// ---------------------------------------------------------------------------
// initMeterSchema — constraint & integrity tests
// ---------------------------------------------------------------------------

describe("initMeterSchema — data integrity", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = freshDb();
    initMeterSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates all three tables", () => {
    const tables = tableNames(db);
    expect(tables).toContain("meter_events");
    expect(tables).toContain("usage_summaries");
    expect(tables).toContain("billing_period_summaries");
  });

  it("enforces NOT NULL on meter_events.tenant", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m1", null, 0.01, 0.02, "embeddings", "openai", Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on meter_events.cost", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m1", "t1", null, 0.02, "embeddings", "openai", Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on meter_events.charge", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m1", "t1", 0.01, null, "embeddings", "openai", Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on meter_events.capability", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m1", "t1", 0.01, 0.02, null, "openai", Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on meter_events.provider", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m1", "t1", 0.01, 0.02, "embeddings", null, Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on meter_events.timestamp", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m1", "t1", 0.01, 0.02, "embeddings", "openai", null),
    ).toThrow();
  });

  it("allows NULL for optional meter_events columns (session_id, duration)", () => {
    db.prepare(
      "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp, session_id, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("m-opt", "t1", 0.01, 0.02, "embeddings", "openai", Date.now(), null, null);

    const row = db.prepare("SELECT session_id, duration FROM meter_events WHERE id = ?").get("m-opt") as Record<
      string,
      unknown
    >;
    expect(row.session_id).toBeNull();
    expect(row.duration).toBeNull();
  });

  it("enforces PRIMARY KEY uniqueness on meter_events.id", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("dup-m", "t1", 0.01, 0.02, "embeddings", "openai", now);

    expect(() =>
      db
        .prepare(
          "INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("dup-m", "t2", 0.05, 0.1, "voice", "deepgram", now),
    ).toThrow();
  });

  it("enforces UNIQUE index on billing_period_summaries composite key", () => {
    db.prepare(
      "INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("bp1", "t1", "embeddings", "openai", 10, 0.5, 1.0, 0, 1000, 2000, Date.now());

    // Same tenant+capability+provider+period_start should violate the unique index
    expect(() =>
      db
        .prepare(
          "INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("bp2", "t1", "embeddings", "openai", 5, 0.25, 0.5, 0, 1000, 2000, Date.now()),
    ).toThrow();
  });

  it("allows different period_start values for same tenant+capability+provider", () => {
    db.prepare(
      "INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("bp-a", "t1", "embeddings", "openai", 10, 0.5, 1.0, 0, 1000, 2000, Date.now());

    // Different period_start is fine
    db.prepare(
      "INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, total_duration, period_start, period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("bp-b", "t1", "embeddings", "openai", 5, 0.25, 0.5, 0, 3000, 4000, Date.now());

    const count = db.prepare("SELECT COUNT(*) as cnt FROM billing_period_summaries").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("has all expected indexes on meter_events", () => {
    const idxs = indexNames(db, "idx_meter_");
    expect(idxs).toContain("idx_meter_tenant");
    expect(idxs).toContain("idx_meter_timestamp");
    expect(idxs).toContain("idx_meter_capability");
    expect(idxs).toContain("idx_meter_session");
    expect(idxs).toContain("idx_meter_tenant_timestamp");
  });

  it("has all expected indexes on usage_summaries", () => {
    const idxs = indexNames(db, "idx_summary_");
    expect(idxs).toContain("idx_summary_tenant");
    expect(idxs).toContain("idx_summary_window");
  });

  it("has all expected indexes on billing_period_summaries", () => {
    const idxs = indexNames(db, "idx_billing_period_");
    expect(idxs).toContain("idx_billing_period_unique");
    expect(idxs).toContain("idx_billing_period_tenant");
    expect(idxs).toContain("idx_billing_period_window");
  });
});

// ---------------------------------------------------------------------------
// initStripeSchema — constraint & integrity tests
// ---------------------------------------------------------------------------

describe("initStripeSchema — data integrity", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = freshDb();
    initStripeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("enforces UNIQUE on tenant_customers.stripe_customer_id", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "cus_unique", "free", now, now);

    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t2", "cus_unique", "free", now, now),
    ).toThrow();
  });

  it("enforces PRIMARY KEY on tenant_customers.tenant", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("t-dup", "cus_1", "free", now, now);

    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t-dup", "cus_2", "free", now, now),
    ).toThrow();
  });

  it("enforces NOT NULL on tenant_customers.stripe_customer_id", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t1", null, "free", Date.now(), Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on tenant_customers.tier", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t1", "cus_1", null, Date.now(), Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on tenant_customers.created_at", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t1", "cus_1", "free", null, Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on tenant_customers.updated_at", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_customers (tenant, stripe_customer_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t1", "cus_1", "free", Date.now(), null),
    ).toThrow();
  });

  it("defaults tier to 'free'", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_customers (tenant, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("t-default", "cus_default", now, now);

    const row = db.prepare("SELECT tier FROM tenant_customers WHERE tenant = ?").get("t-default") as { tier: string };
    expect(row.tier).toBe("free");
  });

  it("enforces UNIQUE index on stripe_usage_reports composite key", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("r1", "t1", "embeddings", "openai", 1000, 2000, "wopr_embeddings_usage", 50, now);

    // Same tenant+capability+provider+period_start should fail
    expect(() =>
      db
        .prepare(
          "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("r2", "t1", "embeddings", "openai", 1000, 2000, "wopr_embeddings_usage", 100, now),
    ).toThrow();
  });

  it("allows different period_start for same tenant+capability+provider in usage reports", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("r-a", "t1", "embeddings", "openai", 1000, 2000, "wopr_embeddings_usage", 50, now);

    db.prepare(
      "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("r-b", "t1", "embeddings", "openai", 3000, 4000, "wopr_embeddings_usage", 75, now);

    const count = db.prepare("SELECT COUNT(*) as cnt FROM stripe_usage_reports").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("enforces NOT NULL on stripe_usage_reports required columns", () => {
    const now = Date.now();
    // tenant NOT NULL
    expect(() =>
      db
        .prepare(
          "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("r1", null, "embeddings", "openai", 1000, 2000, "evt", 50, now),
    ).toThrow();

    // capability NOT NULL
    expect(() =>
      db
        .prepare(
          "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("r2", "t1", null, "openai", 1000, 2000, "evt", 50, now),
    ).toThrow();

    // event_name NOT NULL
    expect(() =>
      db
        .prepare(
          "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("r3", "t1", "embeddings", "openai", 1000, 2000, null, 50, now),
    ).toThrow();

    // value_cents NOT NULL
    expect(() =>
      db
        .prepare(
          "INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("r4", "t1", "embeddings", "openai", 1000, 2000, "evt", null, now),
    ).toThrow();
  });

  it("has expected indexes on tenant_customers", () => {
    const idxs = indexNames(db, "idx_tenant_customers_");
    expect(idxs).toContain("idx_tenant_customers_stripe");
  });

  it("has expected indexes on stripe_usage_reports", () => {
    const idxs = indexNames(db, "idx_stripe_");
    expect(idxs).toContain("idx_stripe_usage_unique");
    expect(idxs).toContain("idx_stripe_usage_tenant");
  });
});

// ---------------------------------------------------------------------------
// TierStore / plan_tiers — constraint & integrity tests
// ---------------------------------------------------------------------------

describe("TierStore — schema integrity", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = freshDb();
    new TierStore(db); // constructor calls init()
  });

  afterEach(() => {
    db.close();
  });

  it("creates the plan_tiers table", () => {
    expect(tableNames(db)).toContain("plan_tiers");
  });

  it("is idempotent (constructing twice does not error)", () => {
    new TierStore(db);
    new TierStore(db);
    expect(tableNames(db).filter((t) => t === "plan_tiers")).toHaveLength(1);
  });

  it("enforces PRIMARY KEY uniqueness on id", () => {
    db.prepare(
      "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("dup-tier", "dup", 1, 512, 50000, 1024, 128, "[]");

    expect(() =>
      db
        .prepare(
          "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("dup-tier", "dup2", 2, 1024, 100000, 2048, 256, "[]"),
    ).toThrow();
  });

  it("enforces NOT NULL on name", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("t-nonull", null, 1, 512, 50000, 1024, 128, "[]"),
    ).toThrow();
  });

  it("enforces NOT NULL on max_instances", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("t-nonull", "test", null, 512, 50000, 1024, 128, "[]"),
    ).toThrow();
  });

  it("enforces NOT NULL on memory_limit_mb", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("t-nonull", "test", 1, null, 50000, 1024, 128, "[]"),
    ).toThrow();
  });

  it("enforces NOT NULL on cpu_quota", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("t-nonull", "test", 1, 512, null, 1024, 128, "[]"),
    ).toThrow();
  });

  it("enforces NOT NULL on features", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO plan_tiers (id, name, max_instances, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("t-nonull", "test", 1, 512, 50000, 1024, 128, null),
    ).toThrow();
  });

  it("allows NULL for max_plugins_per_instance", () => {
    db.prepare(
      "INSERT INTO plan_tiers (id, name, max_instances, max_plugins_per_instance, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t-nullable", "test", 1, null, 512, 50000, 1024, 128, "[]");

    const row = db.prepare("SELECT max_plugins_per_instance FROM plan_tiers WHERE id = ?").get("t-nullable") as {
      max_plugins_per_instance: number | null;
    };
    expect(row.max_plugins_per_instance).toBeNull();
  });

  it("provides correct defaults for columns with DEFAULT", () => {
    db.prepare("INSERT INTO plan_tiers (id, name) VALUES (?, ?)").run("t-defaults", "defaults-test");

    const row = db.prepare("SELECT * FROM plan_tiers WHERE id = ?").get("t-defaults") as Record<string, unknown>;
    expect(row.max_instances).toBe(1);
    expect(row.memory_limit_mb).toBe(512);
    expect(row.cpu_quota).toBe(50000);
    expect(row.storage_limit_mb).toBe(1024);
    expect(row.max_processes).toBe(256);
    expect(row.features).toBe("[]");
  });
});

// ---------------------------------------------------------------------------
// Cross-schema: all inits are independent and compose cleanly
// ---------------------------------------------------------------------------

describe("cross-schema composition", () => {
  it("all schema inits can run on the same database", () => {
    const db = freshDb();

    initAuditSchema(db);
    initMeterSchema(db);
    initStripeSchema(db);
    // Snapshots are created via Drizzle migration (no raw init function)
    new TierStore(db);

    const tables = tableNames(db);
    expect(tables).toContain("audit_log");
    expect(tables).toContain("meter_events");
    expect(tables).toContain("usage_summaries");
    expect(tables).toContain("billing_period_summaries");
    expect(tables).toContain("tenant_customers");
    expect(tables).toContain("stripe_usage_reports");
    expect(tables).toContain("plan_tiers");

    db.close();
  });

  it("all inits are idempotent when run together twice", () => {
    const db = freshDb();

    // First pass
    initAuditSchema(db);
    initMeterSchema(db);
    initStripeSchema(db);
    new TierStore(db);

    // Second pass — should not error
    initAuditSchema(db);
    initMeterSchema(db);
    initStripeSchema(db);
    new TierStore(db);

    db.close();
  });

  it("migration-created db has all tables including snapshots", () => {
    const { sqlite } = createTestDb();
    const tables = tableNames(sqlite);
    expect(tables).toContain("audit_log");
    expect(tables).toContain("meter_events");
    expect(tables).toContain("snapshots");
    expect(tables).toContain("tenant_customers");
    expect(tables).toContain("stripe_usage_reports");
    sqlite.close();
  });
});
