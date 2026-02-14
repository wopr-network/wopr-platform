import type Database from "better-sqlite3";

/** Initialize the admin audit_log table and indexes. */
export function initAdminAuditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      admin_user TEXT NOT NULL,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      target_tenant TEXT,
      target_user TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_log (admin_user, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant ON admin_audit_log (target_tenant, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log (action, created_at)");
}
