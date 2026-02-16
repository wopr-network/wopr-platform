import type Database from "better-sqlite3";

export function initTenantApiKeysSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_keys_tenant_provider ON tenant_api_keys (tenant_id, provider)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tenant_keys_tenant ON tenant_api_keys (tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tenant_keys_provider ON tenant_api_keys (provider)");
}
