import type Database from "better-sqlite3";

/** Initialize the meter_events and usage_summaries tables. */
export function initMeterSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meter_events (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      cost REAL NOT NULL,
      charge REAL NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      duration INTEGER
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_meter_tenant ON meter_events (tenant)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_meter_timestamp ON meter_events (timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_meter_capability ON meter_events (capability)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_meter_session ON meter_events (session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_meter_tenant_timestamp ON meter_events (tenant, timestamp)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_summaries (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      total_cost REAL NOT NULL,
      total_charge REAL NOT NULL,
      total_duration INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_summary_tenant ON usage_summaries (tenant, window_start)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_summary_window ON usage_summaries (window_start, window_end)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_period_summaries (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      total_cost REAL NOT NULL,
      total_charge REAL NOT NULL,
      total_duration INTEGER NOT NULL DEFAULT 0,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_period_unique ON billing_period_summaries (tenant, capability, provider, period_start)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_billing_period_tenant ON billing_period_summaries (tenant, period_start)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_billing_period_window ON billing_period_summaries (period_start, period_end)",
  );
}
