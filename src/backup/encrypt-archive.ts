import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from a passphrase using SHA-256.
 * (The key is already a high-entropy env var, not a human password.)
 */
function deriveKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase).digest();
}

/**
 * Encrypt a file using AES-256-GCM.
 * Output format: [12-byte IV] [encrypted data] [16-byte auth tag]
 */
export async function encryptFile(inputPath: string, outputPath: string, key: string): Promise<void> {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });

  const input = createReadStream(inputPath);
  const output = createWriteStream(outputPath);

  // Write IV first
  output.write(iv);

  // Pipe encrypted data
  await pipeline(input, cipher, output);

  // Append auth tag after pipeline closes the write stream
  const { appendFile } = await import("node:fs/promises");
  await appendFile(outputPath, cipher.getAuthTag());
}

/**
 * Decrypt a file encrypted with encryptFile.
 * Reads: [12-byte IV] [encrypted data] [16-byte auth tag]
 */
export async function decryptFile(inputPath: string, outputPath: string, key: string): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const data = await readFile(inputPath);

  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted file too short");
  }

  const derivedKey = deriveKey(key);
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  await writeFile(outputPath, decrypted);
}
