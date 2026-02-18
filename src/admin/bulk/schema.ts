import type Database from "better-sqlite3";

export function initBulkOperationsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bulk_undo_grants (
      operation_id TEXT PRIMARY KEY,
      tenant_ids TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      admin_user TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undo_deadline INTEGER NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_bulk_undo_deadline ON bulk_undo_grants(undo_deadline)");
}
