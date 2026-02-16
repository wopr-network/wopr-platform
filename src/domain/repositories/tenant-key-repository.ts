/**
 * Repository Interface: TenantKeyRepository (ASYNC)
 *
 * Manages tenant API keys for external providers.
 * Keys are encrypted before storage.
 */
import type { EncryptedPayload } from "../../security/types.js";

export interface TenantApiKey {
  id: string;
  tenantId: string;
  provider: string;
  label: string;
  encryptedKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface TenantApiKeyWithoutKey {
  id: string;
  tenantId: string;
  provider: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface TenantKeyRepository {
  /**
   * Store or replace a tenant's key for a provider.
   * Returns the record ID.
   */
  upsert(tenantId: string, provider: string, encryptedKey: EncryptedPayload, label?: string): Promise<string>;

  /**
   * Get a tenant's key record for a provider.
   * Returns undefined if none stored.
   */
  get(tenantId: string, provider: string): Promise<TenantApiKey | null>;

  /**
   * List all key records for a tenant.
   * Never returns plaintext keys.
   */
  listForTenant(tenantId: string): Promise<TenantApiKeyWithoutKey[]>;

  /**
   * Delete a tenant's key for a provider.
   * Returns true if a row was deleted.
   */
  delete(tenantId: string, provider: string): Promise<boolean>;

  /**
   * Delete all keys for a tenant.
   * Returns the number of rows deleted.
   */
  deleteAllForTenant(tenantId: string): Promise<number>;
}
