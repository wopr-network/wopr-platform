import type Database from "better-sqlite3";

/** Initialize the user_roles table and indexes. */
export function initRolesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      granted_by TEXT,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tenant_id)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_user_roles_tenant ON user_roles (tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles (role)");
}
