import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EncryptedPayload } from "../types.js";

/** A stored tenant API key record. */
export interface TenantApiKey {
  id: string;
  tenant_id: string;
  provider: string;
  /** Label for display (e.g. "My Anthropic key"). Never contains the key itself. */
  label: string;
  /** AES-256-GCM encrypted key payload (JSON-serialized EncryptedPayload). */
  encrypted_key: string;
  created_at: number;
  updated_at: number;
}

/** Initialize the tenant_api_keys table. */
export function initTenantKeySchema(db: Database.Database): void {
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

  // One key per provider per tenant
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_keys_tenant_provider ON tenant_api_keys (tenant_id, provider)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tenant_keys_tenant ON tenant_api_keys (tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tenant_keys_provider ON tenant_api_keys (provider)");
}

/** CRUD store for tenant API keys. */
export class TenantKeyStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    initTenantKeySchema(db);
  }

  /** Store or replace a tenant's key for a provider. Returns the record ID. */
  upsert(tenantId: string, provider: string, encryptedKey: EncryptedPayload, label = ""): string {
    const now = Date.now();
    const serialized = JSON.stringify(encryptedKey);

    const existing = this.db
      .prepare("SELECT id FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?")
      .get(tenantId, provider) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare("UPDATE tenant_api_keys SET encrypted_key = ?, label = ?, updated_at = ? WHERE id = ?")
        .run(serialized, label, now, existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, tenantId, provider, label, serialized, now, now);
    return id;
  }

  /** Get a tenant's key record for a provider. Returns undefined if none stored. */
  get(tenantId: string, provider: string): TenantApiKey | undefined {
    return this.db
      .prepare("SELECT * FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?")
      .get(tenantId, provider) as TenantApiKey | undefined;
  }

  /** List all key records for a tenant. Never returns plaintext keys. */
  listForTenant(tenantId: string): Omit<TenantApiKey, "encrypted_key">[] {
    return this.db
      .prepare("SELECT id, tenant_id, provider, label, created_at, updated_at FROM tenant_api_keys WHERE tenant_id = ?")
      .all(tenantId) as Omit<TenantApiKey, "encrypted_key">[];
  }

  /** Delete a tenant's key for a provider. Returns true if a row was deleted. */
  delete(tenantId: string, provider: string): boolean {
    const result = this.db
      .prepare("DELETE FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?")
      .run(tenantId, provider);
    return result.changes > 0;
  }

  /** Delete all keys for a tenant. Returns the number of rows deleted. */
  deleteAllForTenant(tenantId: string): number {
    const result = this.db.prepare("DELETE FROM tenant_api_keys WHERE tenant_id = ?").run(tenantId);
    return result.changes;
  }
}
