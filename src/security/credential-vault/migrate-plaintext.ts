import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { providerCredentials, tenantApiKeys } from "../../db/schema/index.js";
import { encrypt } from "../encryption.js";
import { scanForKeyLeaks } from "../key-audit.js";

export interface MigrationResult {
  table: string;
  migratedCount: number;
  errors: string[];
}

/**
 * Migrate any plaintext credentials to encrypted form.
 *
 * For provider_credentials: re-encrypts encrypted_value column using vaultKey.
 * For tenant_api_keys: re-encrypts encrypted_key column using tenantKeyDeriver.
 *
 * IMPORTANT: This is destructive — run in a transaction and back up first.
 */
export async function migratePlaintextCredentials(
  db: DrizzleDb,
  vaultKey: Buffer,
  tenantKeyDeriver: (tenantId: string) => Buffer,
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];

  // --- provider_credentials ---
  const provResult: MigrationResult = {
    table: "provider_credentials",
    migratedCount: 0,
    errors: [],
  };

  const provRows = await db
    .select({ id: providerCredentials.id, encryptedValue: providerCredentials.encryptedValue })
    .from(providerCredentials);

  for (const row of provRows) {
    try {
      const parsed = JSON.parse(row.encryptedValue);
      if (parsed.iv && parsed.authTag && parsed.ciphertext) {
        continue; // Already encrypted
      }
    } catch {
      // Not JSON — treat as plaintext
    }

    // This row has plaintext data — encrypt it
    const leaks = scanForKeyLeaks(row.encryptedValue);
    if (leaks.length === 0 && row.encryptedValue.trim() === "") {
      continue; // Empty value, skip
    }

    try {
      const encrypted = encrypt(row.encryptedValue, vaultKey);
      const serialized = JSON.stringify(encrypted);
      await db
        .update(providerCredentials)
        .set({ encryptedValue: serialized })
        .where(eq(providerCredentials.id, row.id));
      provResult.migratedCount++;
    } catch (err) {
      provResult.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  results.push(provResult);

  // --- tenant_api_keys ---
  try {
    const tenantResult: MigrationResult = {
      table: "tenant_api_keys",
      migratedCount: 0,
      errors: [],
    };

    const tenantRows = await db
      .select({ id: tenantApiKeys.id, tenantId: tenantApiKeys.tenantId, encryptedKey: tenantApiKeys.encryptedKey })
      .from(tenantApiKeys);

    for (const row of tenantRows) {
      try {
        const parsed = JSON.parse(row.encryptedKey);
        if (parsed.iv && parsed.authTag && parsed.ciphertext) {
          continue; // Already encrypted
        }
      } catch {
        // Not JSON — treat as plaintext
      }

      if (row.encryptedKey.trim() === "") continue;

      try {
        const tenantKey = tenantKeyDeriver(row.tenantId);
        const encrypted = encrypt(row.encryptedKey, tenantKey);
        const serialized = JSON.stringify(encrypted);
        await db.update(tenantApiKeys).set({ encryptedKey: serialized }).where(eq(tenantApiKeys.id, row.id));
        tenantResult.migratedCount++;
      } catch (err) {
        tenantResult.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    results.push(tenantResult);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("no such table"))) throw err;
    // Table doesn't exist
  }

  return results;
}
