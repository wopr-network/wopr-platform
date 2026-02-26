import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantApiKeys } from "../../db/schema/index.js";
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

export interface ITenantKeyStore {
  upsert(tenantId: string, provider: string, encryptedKey: EncryptedPayload, label?: string): Promise<string>;
  get(tenantId: string, provider: string): Promise<TenantApiKey | undefined>;
  listForTenant(tenantId: string): Promise<Omit<TenantApiKey, "encrypted_key">[]>;
  delete(tenantId: string, provider: string): Promise<boolean>;
  deleteAllForTenant(tenantId: string): Promise<number>;
}

/** CRUD store for tenant API keys using Drizzle ORM. */
export class TenantKeyStore implements ITenantKeyStore {
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  /** Store or replace a tenant's key for a provider. Returns the record ID. */
  async upsert(tenantId: string, provider: string, encryptedKey: EncryptedPayload, label = ""): Promise<string> {
    const now = Date.now();
    const serialized = JSON.stringify(encryptedKey);

    const existing = await this.db
      .select({ id: tenantApiKeys.id })
      .from(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(tenantApiKeys)
        .set({ encryptedKey: serialized, label, updatedAt: now })
        .where(eq(tenantApiKeys.id, existing[0].id));
      return existing[0].id;
    }

    const id = randomUUID();
    await this.db.insert(tenantApiKeys).values({
      id,
      tenantId,
      provider,
      label,
      encryptedKey: serialized,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /** Get a tenant's key record for a provider. Returns undefined if none stored. */
  async get(tenantId: string, provider: string): Promise<TenantApiKey | undefined> {
    const rows = await this.db
      .select()
      .from(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
      .limit(1);

    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      id: r.id,
      tenant_id: r.tenantId,
      provider: r.provider,
      label: r.label,
      encrypted_key: r.encryptedKey,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }

  /** List all key records for a tenant. Never returns plaintext keys. */
  async listForTenant(tenantId: string): Promise<Omit<TenantApiKey, "encrypted_key">[]> {
    const rows = await this.db
      .select({
        id: tenantApiKeys.id,
        tenantId: tenantApiKeys.tenantId,
        provider: tenantApiKeys.provider,
        label: tenantApiKeys.label,
        createdAt: tenantApiKeys.createdAt,
        updatedAt: tenantApiKeys.updatedAt,
      })
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.tenantId, tenantId));

    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenantId,
      provider: r.provider,
      label: r.label,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  /** Delete a tenant's key for a provider. Returns true if a row was deleted. */
  async delete(tenantId: string, provider: string): Promise<boolean> {
    const result = await this.db
      .delete(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.provider, provider)))
      .returning({ id: tenantApiKeys.id });
    return result.length > 0;
  }

  /** Delete all keys for a tenant. Returns the number of rows deleted. */
  async deleteAllForTenant(tenantId: string): Promise<number> {
    const result = await this.db
      .delete(tenantApiKeys)
      .where(eq(tenantApiKeys.tenantId, tenantId))
      .returning({ id: tenantApiKeys.id });
    return result.length;
  }
}
