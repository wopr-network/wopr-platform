import type Database from "better-sqlite3";

/** Initialize the credit_transactions and credit_balances tables for testing. */
export function initCreditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_credits INTEGER NOT NULL,
      balance_after_credits INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT UNIQUE,
      funding_source TEXT,
      attributed_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add funding_source column if it doesn't exist
  const cols = db.prepare("PRAGMA table_info(credit_transactions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "funding_source")) {
    db.exec("ALTER TABLE credit_transactions ADD COLUMN funding_source TEXT");
  }
  if (!cols.some((c) => c.name === "attributed_user_id")) {
    db.exec("ALTER TABLE credit_transactions ADD COLUMN attributed_user_id TEXT");
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant ON credit_transactions(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_type ON credit_transactions(type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_ref ON credit_transactions(reference_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_created ON credit_transactions(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_created ON credit_transactions(tenant_id, created_at)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_credits INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
