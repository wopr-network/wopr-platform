import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProfileStore } from "./profile-store.js";
import type { BotProfile } from "./types.js";

describe("ProfileStore Path Traversal Protection", () => {
  const testDataDir = join(process.cwd(), "test-data-profile-store");
  let store: ProfileStore;

  beforeEach(async () => {
    await mkdir(testDataDir, { recursive: true });
    store = new ProfileStore(testDataDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true });
  });

  describe("Valid UUIDs", () => {
    test("should accept valid lowercase UUID", async () => {
      const validId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const profile: BotProfile = {
        id: validId,
        tenantId: "test-tenant",
        name: "test-bot",
        description: "Test profile",
        image: "ghcr.io/wopr-network/test:latest",
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      };

      await expect(store.save(profile)).resolves.not.toThrow();
      const retrieved = await store.get(validId);
      expect(retrieved).toEqual(profile);
      await expect(store.delete(validId)).resolves.toBe(true);
    });

    test("should accept valid uppercase UUID", async () => {
      const validId = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
      const profile: BotProfile = {
        id: validId,
        tenantId: "test-tenant",
        name: "test-bot",
        description: "Test profile",
        image: "ghcr.io/wopr-network/test:latest",
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      };

      await expect(store.save(profile)).resolves.not.toThrow();
      const retrieved = await store.get(validId);
      expect(retrieved).toEqual(profile);
    });

    test("should accept valid mixed-case UUID", async () => {
      const validId = "a1B2c3D4-e5F6-7890-AbCd-Ef1234567890";
      const profile: BotProfile = {
        id: validId,
        tenantId: "test-tenant",
        name: "test-bot",
        description: "Test profile",
        image: "ghcr.io/wopr-network/test:latest",
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      };

      await expect(store.save(profile)).resolves.not.toThrow();
    });
  });

  describe("Path Traversal Attacks", () => {
    test("should reject Unix path traversal (../../etc/passwd)", async () => {
      const maliciousId = "../../etc/passwd";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject Windows path traversal (..\\..\\windows\\system32)", async () => {
      const maliciousId = "..\\..\\windows\\system32";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject mixed path separators (../..\\etc/passwd)", async () => {
      const maliciousId = "../..\\etc/passwd";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject absolute paths (/etc/passwd)", async () => {
      const maliciousId = "/etc/passwd";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject Windows absolute paths (C:\\windows\\system32)", async () => {
      const maliciousId = "C:\\windows\\system32";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject URL-encoded traversal (%2e%2e%2f)", async () => {
      const maliciousId = "%2e%2e%2f%2e%2e%2fetc%2fpasswd";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject null byte injection (../../etc/passwd\\0)", async () => {
      const maliciousId = "../../etc/passwd\0.yaml";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject path traversal in delete()", async () => {
      const maliciousId = "../../etc/passwd";
      await expect(store.delete(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject path traversal in save()", async () => {
      const profile: BotProfile = {
        id: "../../etc/passwd",
        tenantId: "test-tenant",
        name: "test-bot",
        description: "Malicious profile",
        image: "ghcr.io/wopr-network/test:latest",
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      };
      await expect(store.save(profile)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });
  });

  describe("Invalid ID Formats", () => {
    test("should reject empty string", async () => {
      await expect(store.get("")).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject non-UUID string", async () => {
      await expect(store.get("not-a-uuid")).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject UUID with wrong segment lengths", async () => {
      const invalidId = "a1b2c3d4-e5f6-7890-abcd-ef12345678901"; // one extra char
      await expect(store.get(invalidId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject UUID with invalid characters", async () => {
      const invalidId = "a1b2c3d4-e5f6-7890-abcd-ef12345678gg"; // 'gg' not hex
      await expect(store.get(invalidId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject UUID missing dashes", async () => {
      const invalidId = "a1b2c3d4e5f67890abcdef1234567890";
      await expect(store.get(invalidId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject SQL injection attempt", async () => {
      const maliciousId = "'; DROP TABLE profiles; --";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });

    test("should reject command injection attempt", async () => {
      const maliciousId = "; rm -rf /";
      await expect(store.get(maliciousId)).rejects.toThrow(
        "Invalid profile ID: must be a UUID"
      );
    });
  });

  describe("Edge Cases", () => {
    test("should handle get() returning null for non-existent valid UUID", async () => {
      const validId = "00000000-0000-0000-0000-000000000000";
      const result = await store.get(validId);
      expect(result).toBeNull();
    });

    test("should handle delete() returning false for non-existent valid UUID", async () => {
      const validId = "00000000-0000-0000-0000-000000000000";
      const result = await store.delete(validId);
      expect(result).toBe(false);
    });

    test("should handle list() without crashing on protected store", async () => {
      const profiles = await store.list();
      expect(Array.isArray(profiles)).toBe(true);
    });
  });
});
