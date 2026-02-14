import type Database from "better-sqlite3";
import { decrypt } from "../encryption.js";
import type { Provider } from "../types.js";
import type { TenantApiKey } from "./schema.js";

/** Result of resolving which API key to use. */
export interface ResolvedKey {
  /** The plaintext API key. */
  key: string;
  /** Where the key came from. */
  source: "tenant" | "pooled";
  /** The provider the key is for. */
  provider: Provider;
}

/**
 * Resolve which API key to use for a given tenant and provider.
 *
 * Resolution order:
 * 1. If the tenant has a BYOK key stored, decrypt and return it.
 * 2. Otherwise, fall back to the pooled (platform-level) key from env vars.
 * 3. If neither exists, return null.
 *
 * SECURITY: The decrypted key is returned to the caller and must be discarded
 * after use. This function does not log, persist, or cache the plaintext key.
 *
 * @param db - Database connection with tenant_api_keys table initialized
 * @param tenantId - The tenant requesting the key
 * @param provider - The AI provider (anthropic, openai, google, discord)
 * @param encryptionKey - The 32-byte key used to decrypt the stored BYOK key
 * @param pooledKeys - Map of provider -> pooled API key (from env vars)
 */
export function resolveApiKey(
  db: Database.Database,
  tenantId: string,
  provider: Provider,
  encryptionKey: Buffer,
  pooledKeys: Map<Provider, string>,
): ResolvedKey | null {
  // 1. Check for tenant BYOK key
  const row = db
    .prepare("SELECT encrypted_key FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?")
    .get(tenantId, provider) as Pick<TenantApiKey, "encrypted_key"> | undefined;

  if (row) {
    const payload = JSON.parse(row.encrypted_key);
    const plaintext = decrypt(payload, encryptionKey);
    return { key: plaintext, source: "tenant", provider };
  }

  // 2. Fall back to pooled key
  const pooledKey = pooledKeys.get(provider);
  if (pooledKey) {
    return { key: pooledKey, source: "pooled", provider };
  }

  // 3. No key available
  return null;
}

/**
 * Build a pooled keys map from environment variables.
 *
 * Reads:
 * - ANTHROPIC_API_KEY
 * - OPENAI_API_KEY
 * - GOOGLE_API_KEY
 * - DISCORD_BOT_TOKEN
 */
export function buildPooledKeysMap(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Map<Provider, string> {
  const keys = new Map<Provider, string>();

  const mapping: [string, Provider][] = [
    ["ANTHROPIC_API_KEY", "anthropic"],
    ["OPENAI_API_KEY", "openai"],
    ["GOOGLE_API_KEY", "google"],
    ["DISCORD_BOT_TOKEN", "discord"],
  ];

  for (const [envVar, provider] of mapping) {
    const val = env[envVar]?.trim();
    if (val) {
      keys.set(provider, val);
    }
  }

  return keys;
}
