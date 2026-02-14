import type Database from "better-sqlite3";

/** Initialize the credit_transactions and credit_balances tables for testing. */
export function initCreditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant ON credit_transactions(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_ref ON credit_transactions(reference_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_created ON credit_transactions(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_created ON credit_transactions(tenant_id, created_at)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
