import type Database from "better-sqlite3";
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
export function migratePlaintextCredentials(
  db: Database.Database,
  vaultKey: Buffer,
  tenantKeyDeriver: (tenantId: string) => Buffer,
): MigrationResult[] {
  const results: MigrationResult[] = [];

  // --- provider_credentials ---
  const provResult: MigrationResult = {
    table: "provider_credentials",
    migratedCount: 0,
    errors: [],
  };

  const provRows = db.prepare("SELECT id, encrypted_value FROM provider_credentials").all() as {
    id: string;
    encrypted_value: string;
  }[];

  for (const row of provRows) {
    try {
      const parsed = JSON.parse(row.encrypted_value);
      if (parsed.iv && parsed.authTag && parsed.ciphertext) {
        continue; // Already encrypted
      }
    } catch {
      // Not JSON — treat as plaintext
    }

    // This row has plaintext data — encrypt it
    const leaks = scanForKeyLeaks(row.encrypted_value);
    if (leaks.length === 0 && row.encrypted_value.trim() === "") {
      continue; // Empty value, skip
    }

    try {
      const encrypted = encrypt(row.encrypted_value, vaultKey);
      const serialized = JSON.stringify(encrypted);
      db.prepare("UPDATE provider_credentials SET encrypted_value = ? WHERE id = ?").run(serialized, row.id);
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

    const tenantRows = db.prepare("SELECT id, tenant_id, encrypted_key FROM tenant_api_keys").all() as {
      id: string;
      tenant_id: string;
      encrypted_key: string;
    }[];

    for (const row of tenantRows) {
      try {
        const parsed = JSON.parse(row.encrypted_key);
        if (parsed.iv && parsed.authTag && parsed.ciphertext) {
          continue; // Already encrypted
        }
      } catch {
        // Not JSON — treat as plaintext
      }

      if (row.encrypted_key.trim() === "") continue;

      try {
        const tenantKey = tenantKeyDeriver(row.tenant_id);
        const encrypted = encrypt(row.encrypted_key, tenantKey);
        const serialized = JSON.stringify(encrypted);
        db.prepare("UPDATE tenant_api_keys SET encrypted_key = ? WHERE id = ?").run(serialized, row.id);
        tenantResult.migratedCount++;
      } catch (err) {
        tenantResult.errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    results.push(tenantResult);
  } catch {
    // Table doesn't exist
  }

  return results;
}
