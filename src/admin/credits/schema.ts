import type Database from "better-sqlite3";

/** Initialize the credit_adjustments table and indexes. */
export function initCreditAdjustmentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_adjustments (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      reason TEXT NOT NULL,
      admin_user TEXT NOT NULL,
      reference_ids TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_adjustments_tenant ON credit_adjustments(tenant)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_adjustments_type ON credit_adjustments(type, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_adjustments_created ON credit_adjustments(created_at)");
}
