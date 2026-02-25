import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { providerCredentials, tenantApiKeys } from "../../db/schema/index.js";
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
export function reEncryptAllCredentials(
  db: BetterSQLite3Database<Record<string, unknown>>,
  oldSecret: string,
  newSecret: string,
): RotationResult {
  const result: RotationResult = {
    providerCredentials: { migrated: 0, errors: [] },
    tenantKeys: { migrated: 0, errors: [] },
  };

  const oldVaultKey = getVaultEncryptionKey(oldSecret);
  const newVaultKey = getVaultEncryptionKey(newSecret);

  // --- provider_credentials ---
  const provRows = db
    .select({ id: providerCredentials.id, encryptedValue: providerCredentials.encryptedValue })
    .from(providerCredentials)
    .all();

  for (const row of provRows) {
    try {
      const payload: EncryptedPayload = JSON.parse(row.encryptedValue);
      const plaintext = decrypt(payload, oldVaultKey);
      const reEncrypted = encrypt(plaintext, newVaultKey);
      db.update(providerCredentials)
        .set({ encryptedValue: JSON.stringify(reEncrypted) })
        .where(eq(providerCredentials.id, row.id))
        .run();
      result.providerCredentials.migrated++;
    } catch (err) {
      result.providerCredentials.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- tenant_api_keys ---
  try {
    const tenantRows = db
      .select({
        id: tenantApiKeys.id,
        tenantId: tenantApiKeys.tenantId,
        encryptedKey: tenantApiKeys.encryptedKey,
      })
      .from(tenantApiKeys)
      .all();

    for (const row of tenantRows) {
      try {
        const payload: EncryptedPayload = JSON.parse(row.encryptedKey);
        const oldTenantKey = deriveTenantKey(row.tenantId, oldSecret);
        const plaintext = decrypt(payload, oldTenantKey);
        const newTenantKey = deriveTenantKey(row.tenantId, newSecret);
        const reEncrypted = encrypt(plaintext, newTenantKey);
        db.update(tenantApiKeys)
          .set({ encryptedKey: JSON.stringify(reEncrypted) })
          .where(eq(tenantApiKeys.id, row.id))
          .run();
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
