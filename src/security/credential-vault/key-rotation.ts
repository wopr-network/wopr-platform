import { createHmac } from "node:crypto";
import { decrypt, encrypt } from "../encryption.js";
import type { EncryptedPayload } from "../types.js";
import type { ICredentialMigrationAccess, IMigrationTenantKeyAccess } from "./credential-repository.js";
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
 */
export async function reEncryptAllCredentials(
  credentialAccess: ICredentialMigrationAccess,
  tenantKeyAccess: IMigrationTenantKeyAccess,
  oldSecret: string,
  newSecret: string,
): Promise<RotationResult> {
  const result: RotationResult = {
    providerCredentials: { migrated: 0, errors: [] },
    tenantKeys: { migrated: 0, errors: [] },
  };

  const oldVaultKey = getVaultEncryptionKey(oldSecret);
  const newVaultKey = getVaultEncryptionKey(newSecret);

  // --- provider_credentials ---
  const provRows = await credentialAccess.listAllWithEncryptedValue();

  for (const row of provRows) {
    try {
      const payload: EncryptedPayload = JSON.parse(row.encryptedValue);
      const plaintext = decrypt(payload, oldVaultKey);
      const reEncrypted = encrypt(plaintext, newVaultKey);
      await credentialAccess.updateEncryptedValueOnly(row.id, JSON.stringify(reEncrypted));
      result.providerCredentials.migrated++;
    } catch (err) {
      result.providerCredentials.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- tenant_api_keys ---
  const tenantRows = await tenantKeyAccess.listAll();

  for (const row of tenantRows) {
    try {
      const payload: EncryptedPayload = JSON.parse(row.encryptedKey);
      const oldTenantKey = deriveTenantKey(row.tenantId, oldSecret);
      const plaintext = decrypt(payload, oldTenantKey);
      const newTenantKey = deriveTenantKey(row.tenantId, newSecret);
      const reEncrypted = encrypt(plaintext, newTenantKey);
      await tenantKeyAccess.updateEncryptedKey(row.id, JSON.stringify(reEncrypted));
      result.tenantKeys.migrated++;
    } catch (err) {
      result.tenantKeys.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
