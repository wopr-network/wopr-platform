import type { DrizzleDb } from "../../db/index.js";
import { providerCredentials, tenantApiKeys } from "../../db/schema/index.js";
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

export async function auditCredentialEncryption(db: DrizzleDb): Promise<PlaintextFinding[]> {
  const findings: PlaintextFinding[] = [];

  // Check provider_credentials.encrypted_value
  const providerRows = await db
    .select({ id: providerCredentials.id, encryptedValue: providerCredentials.encryptedValue })
    .from(providerCredentials);

  for (const row of providerRows) {
    // A properly encrypted value should be a JSON object with iv/authTag/ciphertext
    try {
      const parsed = JSON.parse(row.encryptedValue);
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
      const leaks = scanForKeyLeaks(row.encryptedValue);
      if (leaks.length > 0 || row.encryptedValue.trim().length > 0) {
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
    const tenantRows = await db
      .select({ id: tenantApiKeys.id, encryptedKey: tenantApiKeys.encryptedKey })
      .from(tenantApiKeys);

    for (const row of tenantRows) {
      try {
        const parsed = JSON.parse(row.encryptedKey);
        if (!parsed.iv || !parsed.authTag || !parsed.ciphertext) {
          findings.push({
            table: "tenant_api_keys",
            column: "encrypted_key",
            rowId: row.id,
            provider: "unknown",
          });
        }
      } catch {
        const leaks = scanForKeyLeaks(row.encryptedKey);
        if (leaks.length > 0 || row.encryptedKey.trim().length > 0) {
          findings.push({
            table: "tenant_api_keys",
            column: "encrypted_key",
            rowId: row.id,
            provider: leaks[0]?.provider ?? "unknown",
          });
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("no such table"))) throw err;
    // Table doesn't exist yet — that's fine
  }

  return findings;
}
