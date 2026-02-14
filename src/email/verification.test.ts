import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateVerificationToken,
  getUserEmail,
  initVerificationSchema,
  isEmailVerified,
  verifyToken,
} from "./verification.js";

describe("email verification", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Create a minimal user table mimicking better-auth's schema
    db.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        createdAt TEXT
      )
    `);
    initVerificationSchema(db);

    // Insert test users
    db.prepare("INSERT INTO user (id, email, name) VALUES (?, ?, ?)").run("user-1", "alice@test.com", "Alice");
    db.prepare("INSERT INTO user (id, email, name) VALUES (?, ?, ?)").run("user-2", "bob@test.com", "Bob");
  });

  afterEach(() => {
    db.close();
  });

  describe("initVerificationSchema", () => {
    it("should add verification columns idempotently", () => {
      // Call again — should not throw
      initVerificationSchema(db);

      const columns = db.pragma("table_info(user)") as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("email_verified");
      expect(names).toContain("verification_token");
      expect(names).toContain("verification_expires");
    });
  });

  describe("generateVerificationToken", () => {
    it("should generate a 64-char hex token", () => {
      const result = generateVerificationToken(db, "user-1");
      expect(result.token).toHaveLength(64);
      expect(result.token).toMatch(/^[a-f0-9]+$/);
    });

    it("should store token and expiry in the database", () => {
      const result = generateVerificationToken(db, "user-1");

      const row = db
        .prepare("SELECT verification_token, verification_expires FROM user WHERE id = ?")
        .get("user-1") as {
        verification_token: string;
        verification_expires: string;
      };

      expect(row.verification_token).toBe(result.token);
      expect(row.verification_expires).toBe(result.expiresAt);
    });

    it("should set expiry 24 hours in the future", () => {
      const before = Date.now();
      const result = generateVerificationToken(db, "user-1");
      const after = Date.now();

      const expiresMs = new Date(result.expiresAt).getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      expect(expiresMs).toBeGreaterThanOrEqual(before + twentyFourHours);
      expect(expiresMs).toBeLessThanOrEqual(after + twentyFourHours);
    });

    it("should overwrite previous token on re-generation", () => {
      const first = generateVerificationToken(db, "user-1");
      const second = generateVerificationToken(db, "user-1");

      expect(first.token).not.toBe(second.token);

      const row = db.prepare("SELECT verification_token FROM user WHERE id = ?").get("user-1") as {
        verification_token: string;
      };
      expect(row.verification_token).toBe(second.token);
    });
  });

  describe("verifyToken", () => {
    it("should verify a valid token and mark user as verified", () => {
      const { token } = generateVerificationToken(db, "user-1");
      const result = verifyToken(db, token);

      expect(result).toEqual({ userId: "user-1", email: "alice@test.com" });

      // Check user is now verified
      const row = db.prepare("SELECT email_verified, verification_token FROM user WHERE id = ?").get("user-1") as {
        email_verified: number;
        verification_token: string | null;
      };
      expect(row.email_verified).toBe(1);
      expect(row.verification_token).toBeNull();
    });

    it("should return null for non-existent token", () => {
      expect(verifyToken(db, "a".repeat(64))).toBeNull();
    });

    it("should return null for empty token", () => {
      expect(verifyToken(db, "")).toBeNull();
    });

    it("should return null for wrong-length token", () => {
      expect(verifyToken(db, "abc")).toBeNull();
    });

    it("should return null for expired token", () => {
      const { token } = generateVerificationToken(db, "user-1");

      // Manually set expiry to the past
      db.prepare("UPDATE user SET verification_expires = ? WHERE id = ?").run(
        new Date(Date.now() - 1000).toISOString(),
        "user-1",
      );

      expect(verifyToken(db, token)).toBeNull();
    });

    it("should return null for already-verified user", () => {
      const { token } = generateVerificationToken(db, "user-1");

      // Mark as verified manually
      db.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").run("user-1");

      expect(verifyToken(db, token)).toBeNull();
    });

    it("should only allow single verification per token", () => {
      const { token } = generateVerificationToken(db, "user-1");

      const first = verifyToken(db, token);
      const second = verifyToken(db, token);

      expect(first).toEqual({ userId: "user-1", email: "alice@test.com" });
      expect(second).toBeNull(); // Token was cleared after first verification
    });
  });

  describe("isEmailVerified", () => {
    it("should return false for unverified user", () => {
      expect(isEmailVerified(db, "user-1")).toBe(false);
    });

    it("should return true after verification", () => {
      const { token } = generateVerificationToken(db, "user-1");
      verifyToken(db, token);
      expect(isEmailVerified(db, "user-1")).toBe(true);
    });

    it("should return false for non-existent user", () => {
      expect(isEmailVerified(db, "no-such-user")).toBe(false);
    });
  });

  describe("getUserEmail", () => {
    it("should return email for existing user", () => {
      expect(getUserEmail(db, "user-1")).toBe("alice@test.com");
    });

    it("should return null for non-existent user", () => {
      expect(getUserEmail(db, "no-such-user")).toBeNull();
    });
  });
});
