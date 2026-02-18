import type Database from "better-sqlite3";

/** Initialize the admin_notes table and indexes. */
export function initAdminNotesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_notes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      admin_user TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_notes_tenant ON admin_notes(tenant_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_notes_admin ON admin_notes(admin_user)");
}
