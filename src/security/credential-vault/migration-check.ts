import type Database from "better-sqlite3";
import { scanForKeyLeaks } from "../key-audit.js";

/**
 * Scan all credential columns in the database for plaintext API key patterns.
 * Returns an array of findings. Empty array = all clear.
 *
 * This is a safety net, not a migration — the platform was designed encrypted-first.
 * Run as part of deployment validation or as a periodic security check.
 */
export interface PlaintextFinding {
  table: string;
  column: string;
  rowId: string;
  provider: string;
}

export function auditCredentialEncryption(db: Database.Database): PlaintextFinding[] {
  const findings: PlaintextFinding[] = [];

  // Check provider_credentials.encrypted_value
  const providerRows = db.prepare("SELECT id, encrypted_value FROM provider_credentials").all() as {
    id: string;
    encrypted_value: string;
  }[];

  for (const row of providerRows) {
    // A properly encrypted value should be a JSON object with iv/authTag/ciphertext
    try {
      const parsed = JSON.parse(row.encrypted_value);
      if (!parsed.iv || !parsed.authTag || !parsed.ciphertext) {
        findings.push({
          table: "provider_credentials",
          column: "encrypted_value",
          rowId: row.id,
          provider: "unknown",
        });
      }
    } catch {
      // Not valid JSON = likely plaintext
      const leaks = scanForKeyLeaks(row.encrypted_value);
      if (leaks.length > 0 || row.encrypted_value.length > 0) {
        findings.push({
          table: "provider_credentials",
          column: "encrypted_value",
          rowId: row.id,
          provider: leaks[0]?.provider ?? "unknown",
        });
      }
    }
  }

  // Check tenant_api_keys.encrypted_key (if table exists)
  try {
    const tenantRows = db.prepare("SELECT id, encrypted_key FROM tenant_api_keys").all() as {
      id: string;
      encrypted_key: string;
    }[];

    for (const row of tenantRows) {
      try {
        const parsed = JSON.parse(row.encrypted_key);
        if (!parsed.iv || !parsed.authTag || !parsed.ciphertext) {
          findings.push({
            table: "tenant_api_keys",
            column: "encrypted_key",
            rowId: row.id,
            provider: "unknown",
          });
        }
      } catch {
        const leaks = scanForKeyLeaks(row.encrypted_key);
        if (leaks.length > 0 || row.encrypted_key.length > 0) {
          findings.push({
            table: "tenant_api_keys",
            column: "encrypted_key",
            rowId: row.id,
            provider: leaks[0]?.provider ?? "unknown",
          });
        }
      }
    }
  } catch {
    // Table doesn't exist yet — that's fine
  }

  return findings;
}
