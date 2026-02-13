import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../config/logger.js";
import { encrypt } from "./encryption.js";
import type { EncryptedPayload } from "./types.js";

/**
 * Write an encrypted seed file to an instance's WOPR_HOME volume.
 * Used during initial provisioning when the instance container isn't running yet.
 *
 * The platform writes ciphertext only — it never sees or persists the plaintext keys.
 * The instance decrypts on first boot using its own derived key (injected as a Docker secret).
 *
 * @param woprHome - Absolute path to the instance's WOPR_HOME volume mount.
 * @param secrets - Key-value map of secrets to encrypt.
 * @param instanceKey - The 32-byte instance-derived encryption key.
 * @returns The encrypted payload that was written.
 */
export async function writeEncryptedSeed(
  woprHome: string,
  secrets: Record<string, string>,
  instanceKey: Buffer,
): Promise<EncryptedPayload> {
  const serialized = JSON.stringify(secrets);
  const encrypted = encrypt(serialized, instanceKey);

  await mkdir(woprHome, { recursive: true });
  const seedPath = path.join(woprHome, "secrets.enc");
  await writeFile(seedPath, JSON.stringify(encrypted), { mode: 0o600 });

  logger.info("Wrote encrypted seed file", { path: seedPath });
  return encrypted;
}

/**
 * Forward secrets opaquely to a running instance container.
 * The platform acts as a pass-through — it never parses or logs the request body.
 *
 * @param instanceUrl - The internal URL of the running instance (e.g., http://container:3000).
 * @param sessionToken - The user's session token for authentication.
 * @param opaqueBody - The raw request body string to forward without parsing.
 * @returns Whether the write succeeded.
 */
export async function forwardSecretsToInstance(
  instanceUrl: string,
  sessionToken: string,
  opaqueBody: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const response = await fetch(`${instanceUrl}/config/secrets`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: opaqueBody,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const errorText = await response.text().catch(() => "Unknown error");
    return { ok: false, status: response.status, error: errorText };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to forward secrets";
    logger.error("Failed to forward secrets to instance", { error: message });
    return { ok: false, status: 502, error: message };
  }
}
