import type Database from "better-sqlite3";

/** Initialize the sell_rates and provider_costs tables and indexes. */
export function initRateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sell_rates (
      id TEXT PRIMARY KEY,
      capability TEXT NOT NULL,
      display_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      price_usd REAL NOT NULL,
      model TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_sell_rates_capability ON sell_rates(capability)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sell_rates_active ON sell_rates(is_active)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sell_rates_cap_model ON sell_rates(capability, model)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_costs (
      id TEXT PRIMARY KEY,
      capability TEXT NOT NULL,
      adapter TEXT NOT NULL,
      model TEXT,
      unit TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      latency_class TEXT NOT NULL DEFAULT 'standard',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_costs_capability ON provider_costs(capability)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_costs_adapter ON provider_costs(adapter)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_costs_active ON provider_costs(is_active)");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_costs_cap_adapter_model ON provider_costs(capability, adapter, model)",
  );
}
