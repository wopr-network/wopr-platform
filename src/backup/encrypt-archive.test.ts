import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptFile, encryptFile } from "./encrypt-archive.js";

describe("encrypt-archive", () => {
  let tempDir: string;
  const testKey = "a]3Fk9!mP#wR7xQ2bN8vY5sT0uL6hJ4d"; // 32 chars for AES-256

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "backup-encrypt-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("encrypts and decrypts a file round-trip", async () => {
    const inputPath = join(tempDir, "test.tar.gz");
    const encryptedPath = join(tempDir, "test.tar.gz.enc");
    const decryptedPath = join(tempDir, "test-decrypted.tar.gz");

    const original = Buffer.from("hello backup world ".repeat(1000));
    await writeFile(inputPath, original);

    await encryptFile(inputPath, encryptedPath, testKey);
    await decryptFile(encryptedPath, decryptedPath, testKey);

    const decrypted = await readFile(decryptedPath);
    expect(decrypted).toEqual(original);
  });

  it("encrypted file differs from original", async () => {
    const inputPath = join(tempDir, "test.tar.gz");
    const encryptedPath = join(tempDir, "test.tar.gz.enc");

    await writeFile(inputPath, Buffer.from("sensitive data"));
    await encryptFile(inputPath, encryptedPath, testKey);

    const original = await readFile(inputPath);
    const encrypted = await readFile(encryptedPath);
    expect(encrypted).not.toEqual(original);
  });

  it("throws on wrong decryption key", async () => {
    const inputPath = join(tempDir, "test.tar.gz");
    const encryptedPath = join(tempDir, "test.tar.gz.enc");
    const decryptedPath = join(tempDir, "test-decrypted.tar.gz");

    await writeFile(inputPath, Buffer.from("sensitive data"));
    await encryptFile(inputPath, encryptedPath, testKey);

    await expect(decryptFile(encryptedPath, decryptedPath, "wrong-key-wrong-key-wrong-key-32!")).rejects.toThrow();
  });

  it("throws on encrypted file that is too short", async () => {
    const shortPath = join(tempDir, "short.enc");
    const decryptedPath = join(tempDir, "short-decrypted.tar.gz");

    // Write fewer bytes than IV_LENGTH (12) + AUTH_TAG_LENGTH (16) = 28
    await writeFile(shortPath, Buffer.from("tooshort"));

    await expect(decryptFile(shortPath, decryptedPath, testKey)).rejects.toThrow("Encrypted file too short");
  });

  it("encrypts and decrypts an empty file", async () => {
    const inputPath = join(tempDir, "empty.tar.gz");
    const encryptedPath = join(tempDir, "empty.tar.gz.enc");
    const decryptedPath = join(tempDir, "empty-decrypted.tar.gz");

    await writeFile(inputPath, Buffer.alloc(0));

    await encryptFile(inputPath, encryptedPath, testKey);
    await decryptFile(encryptedPath, decryptedPath, testKey);

    const decrypted = await readFile(decryptedPath);
    expect(decrypted).toEqual(Buffer.alloc(0));
  });

  it("different passphrases produce different ciphertext", async () => {
    const inputPath = join(tempDir, "test.tar.gz");
    const enc1 = join(tempDir, "test1.enc");
    const enc2 = join(tempDir, "test2.enc");

    await writeFile(inputPath, Buffer.from("deterministic test data"));

    await encryptFile(inputPath, enc1, testKey);
    await encryptFile(inputPath, enc2, "other-key-other-key-other-key-32");

    const buf1 = await readFile(enc1);
    const buf2 = await readFile(enc2);
    // Different keys (and random IVs) produce different output
    expect(buf1).not.toEqual(buf2);
  });
});
