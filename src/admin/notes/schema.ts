import type Database from "better-sqlite3";

/** Initialize the admin_notes table and indexes. */
export function initAdminNotesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_notes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_notes_tenant ON admin_notes (tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_notes_pinned ON admin_notes (tenant_id, is_pinned, created_at)");
}
