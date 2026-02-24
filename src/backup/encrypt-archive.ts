import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16;
// Fixed salt — key material comes from a high-entropy env var, not a human password.
// The salt prevents identical keys from producing identical derived keys across deployments.
const SCRYPT_SALT = Buffer.from("wopr-backup-v1-salt");

/**
 * Derive a 32-byte key from a passphrase using scrypt.
 */
function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SCRYPT_SALT, 32);
}

/**
 * Encrypt a file using AES-256-GCM.
 * Output format: [12-byte IV] [encrypted data] [16-byte auth tag]
 *
 * The auth tag is written atomically before the write stream closes — we do
 * NOT use appendFile after pipeline() because pipeline auto-closes the write
 * stream, making any subsequent append a separate open/write which could race
 * or fail silently.
 */
export async function encryptFile(inputPath: string, outputPath: string, key: string): Promise<void> {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });

  const input = createReadStream(inputPath);
  const output = createWriteStream(outputPath);

  // Write IV first
  output.write(iv);

  // Stream encrypted data manually so we can append the auth tag before close
  await new Promise<void>((resolve, reject) => {
    input.on("error", reject);
    cipher.on("error", reject);
    output.on("error", reject);

    cipher.on("data", (chunk: Buffer) => output.write(chunk));
    cipher.on("end", () => {
      // Auth tag is available after cipher finalises — write it before closing
      output.end(cipher.getAuthTag(), () => resolve());
    });

    input.pipe(cipher);
  });
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
