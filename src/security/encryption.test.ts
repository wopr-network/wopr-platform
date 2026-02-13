import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, deriveInstanceKey, encrypt, generateInstanceKey } from "./encryption.js";

describe("encryption", () => {
  describe("generateInstanceKey", () => {
    it("returns a 32-byte buffer", () => {
      const key = generateInstanceKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("generates unique keys", () => {
      const a = generateInstanceKey();
      const b = generateInstanceKey();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("deriveInstanceKey", () => {
    it("returns a 32-byte buffer", () => {
      const key = deriveInstanceKey("instance-123", "platform-secret");
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("is deterministic for the same inputs", () => {
      const a = deriveInstanceKey("instance-123", "secret");
      const b = deriveInstanceKey("instance-123", "secret");
      expect(a.equals(b)).toBe(true);
    });

    it("differs for different instance IDs", () => {
      const a = deriveInstanceKey("instance-1", "secret");
      const b = deriveInstanceKey("instance-2", "secret");
      expect(a.equals(b)).toBe(false);
    });

    it("differs for different secrets", () => {
      const a = deriveInstanceKey("instance-1", "secret-a");
      const b = deriveInstanceKey("instance-1", "secret-b");
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("encrypt / decrypt round-trip", () => {
    const key = generateInstanceKey();

    it("encrypts and decrypts a simple string", () => {
      const plaintext = "hello world";
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it("encrypts and decrypts JSON secrets", () => {
      const secrets = JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-test123", DISCORD_TOKEN: "token123" });
      const encrypted = encrypt(secrets, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(secrets);
    });

    it("encrypts and decrypts empty string", () => {
      const encrypted = encrypt("", key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe("");
    });

    it("produces different ciphertext for same plaintext (random IV)", () => {
      const plaintext = "same data";
      const a = encrypt(plaintext, key);
      const b = encrypt(plaintext, key);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(a.iv).not.toBe(b.iv);
    });

    it("returns hex-encoded fields", () => {
      const encrypted = encrypt("test", key);
      expect(encrypted.iv).toMatch(/^[0-9a-f]+$/);
      expect(encrypted.authTag).toMatch(/^[0-9a-f]+$/);
      expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("decrypt error cases", () => {
    const key = generateInstanceKey();

    it("throws with wrong key", () => {
      const encrypted = encrypt("secret data", key);
      const wrongKey = generateInstanceKey();
      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it("throws with tampered ciphertext", () => {
      const encrypted = encrypt("secret data", key);
      const tampered = { ...encrypted, ciphertext: "deadbeef".repeat(8) };
      expect(() => decrypt(tampered, tampered.iv.length > 0 ? key : key)).toThrow();
    });

    it("throws with tampered auth tag", () => {
      const encrypted = encrypt("secret data", key);
      const tampered = { ...encrypted, authTag: "00".repeat(16) };
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it("throws with wrong key length", () => {
      const shortKey = randomBytes(16);
      expect(() => encrypt("test", shortKey)).toThrow("Encryption key must be 32 bytes");
      expect(() => decrypt({ iv: "", authTag: "", ciphertext: "" }, shortKey)).toThrow(
        "Encryption key must be 32 bytes",
      );
    });
  });
});
