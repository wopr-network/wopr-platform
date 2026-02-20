import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { decrypt, encrypt } from "../encryption.js";
import type { EncryptedPayload } from "../types.js";
import { getVaultEncryptionKey } from "./store.js";

/** Derive a per-tenant encryption key (duplicated from tenant-keys route to avoid circular deps). */
function deriveTenantKey(tenantId: string, platformSecret: string): Buffer {
  return createHmac("sha256", platformSecret).update(`tenant:${tenantId}`).digest();
}

export interface RotationResult {
  providerCredentials: { migrated: number; errors: string[] };
  tenantKeys: { migrated: number; errors: string[] };
}

/**
 * Re-encrypt all credentials from oldSecret to newSecret.
 *
 * MUST be run inside a transaction by the caller.
 * Back up the database before running this.
 *
 * Key Rotation Process for PLATFORM_SECRET:
 *
 * The PLATFORM_SECRET env var is the root secret for all credential encryption:
 * - CredentialVaultStore uses getVaultEncryptionKey(PLATFORM_SECRET) for provider credentials
 * - Tenant BYOK keys use deriveTenantKey(tenantId, PLATFORM_SECRET)
 * - Instance secrets use deriveInstanceKey(instanceId, PLATFORM_SECRET)
 *
 * To rotate PLATFORM_SECRET:
 *
 * 1. Back up the database.
 * 2. Call reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET) inside a transaction.
 * 3. Update PLATFORM_SECRET to the new value in your environment.
 * 4. Restart all platform instances.
 *
 * IMPORTANT: Instance secrets (secrets.enc files) use deriveInstanceKey(instanceId, PLATFORM_SECRET).
 * Running instances will need to be re-seeded with secrets after rotation.
 */
export function reEncryptAllCredentials(db: Database.Database, oldSecret: string, newSecret: string): RotationResult {
  const result: RotationResult = {
    providerCredentials: { migrated: 0, errors: [] },
    tenantKeys: { migrated: 0, errors: [] },
  };

  const oldVaultKey = getVaultEncryptionKey(oldSecret);
  const newVaultKey = getVaultEncryptionKey(newSecret);

  // --- provider_credentials ---
  const provRows = db.prepare("SELECT id, encrypted_value FROM provider_credentials").all() as {
    id: string;
    encrypted_value: string;
  }[];

  for (const row of provRows) {
    try {
      const payload: EncryptedPayload = JSON.parse(row.encrypted_value);
      const plaintext = decrypt(payload, oldVaultKey);
      const reEncrypted = encrypt(plaintext, newVaultKey);
      db.prepare("UPDATE provider_credentials SET encrypted_value = ? WHERE id = ?").run(
        JSON.stringify(reEncrypted),
        row.id,
      );
      result.providerCredentials.migrated++;
    } catch (err) {
      result.providerCredentials.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- tenant_api_keys ---
  try {
    const tenantRows = db.prepare("SELECT id, tenant_id, encrypted_key FROM tenant_api_keys").all() as {
      id: string;
      tenant_id: string;
      encrypted_key: string;
    }[];

    for (const row of tenantRows) {
      try {
        const payload: EncryptedPayload = JSON.parse(row.encrypted_key);
        const oldTenantKey = deriveTenantKey(row.tenant_id, oldSecret);
        const plaintext = decrypt(payload, oldTenantKey);
        const newTenantKey = deriveTenantKey(row.tenant_id, newSecret);
        const reEncrypted = encrypt(plaintext, newTenantKey);
        db.prepare("UPDATE tenant_api_keys SET encrypted_key = ? WHERE id = ?").run(
          JSON.stringify(reEncrypted),
          row.id,
        );
        result.tenantKeys.migrated++;
      } catch (err) {
        result.tenantKeys.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("no such table"))) throw err;
    // Table doesn't exist yet — fine
  }

  return result;
}
