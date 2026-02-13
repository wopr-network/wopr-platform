import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { EncryptedPayload } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Derive a per-instance encryption key from the instance ID and a platform secret.
 * Uses HMAC-SHA256 so the platform never stores the raw key — it's deterministic
 * from (instanceId + platformSecret) but the secret lives only in Docker secrets.
 */
export function deriveInstanceKey(instanceId: string, platformSecret: string): Buffer {
  return createHmac("sha256", platformSecret).update(instanceId).digest();
}

/**
 * Generate a random 32-byte encryption key.
 * Used when creating a new instance to produce a Docker secret.
 */
export function generateInstanceKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a structured payload with iv, authTag, and ciphertext (all hex-encoded).
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload back to plaintext.
 * Throws on tampered data or wrong key.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const iv = Buffer.from(payload.iv, "hex");
  const authTag = Buffer.from(payload.authTag, "hex");
  const ciphertext = Buffer.from(payload.ciphertext, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}
