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
});
