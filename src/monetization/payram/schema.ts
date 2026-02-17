import type Database from "better-sqlite3";

/** Initialize the payram_charges table for tracking payment sessions. */
export function initPayRamSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payram_charges (
      reference_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_usd_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      currency TEXT,
      filled_amount TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      credited_at TEXT
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_payram_charges_tenant ON payram_charges(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payram_charges_status ON payram_charges(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payram_charges_created ON payram_charges(created_at)");
}
