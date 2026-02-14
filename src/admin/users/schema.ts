import type Database from "better-sqlite3";

/** Initialize the admin users table and indexes for admin queries. */
export function initAdminUsersSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'grace_period', 'dormant')),
      role TEXT NOT NULL DEFAULT 'user'
        CHECK (role IN ('platform_admin', 'tenant_admin', 'user')),
      credit_balance_cents INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_users_tenant ON admin_users (tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_users_status ON admin_users (status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users (role)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_users_created ON admin_users (created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_users_last_seen ON admin_users (last_seen)");
}
