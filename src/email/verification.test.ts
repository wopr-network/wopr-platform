import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateVerificationToken,
  getUserEmail,
  initVerificationSchema,
  isEmailVerified,
  verifyToken,
} from "./verification.js";

/** Minimal Pool-like wrapper around PGlite for testing. */
// biome-ignore lint/suspicious/noExplicitAny: test helper wrapping PGlite as Pool
function pgliteAsPool(pg: PGlite): any {
  return { query: (text: string, params?: unknown[]) => pg.query(text, params) };
}

describe("email verification", () => {
  let pg: PGlite;
  // biome-ignore lint/suspicious/noExplicitAny: test pool wrapper
  let pool: any;

  beforeEach(async () => {
    pg = new PGlite();
    pool = pgliteAsPool(pg);

    // Create a minimal user table mimicking better-auth's schema
    await pg.query(`
      CREATE TABLE "user" (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        "createdAt" TEXT
      )
    `);
    await initVerificationSchema(pool);

    // Insert test users
    await pg.query(`INSERT INTO "user" (id, email, name) VALUES ($1, $2, $3)`, ["user-1", "alice@test.com", "Alice"]);
    await pg.query(`INSERT INTO "user" (id, email, name) VALUES ($1, $2, $3)`, ["user-2", "bob@test.com", "Bob"]);
  });

  afterEach(async () => {
    await pg.close();
  });

  describe("initVerificationSchema", () => {
    it("should add verification columns idempotently", async () => {
      // Call again — should not throw
      await initVerificationSchema(pool);

      const { rows } = await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'user' ORDER BY ordinal_position`,
      );
      const names = (rows as Array<{ column_name: string }>).map((r) => r.column_name);
      expect(names).toContain("email_verified");
      expect(names).toContain("verification_token");
      expect(names).toContain("verification_expires");
    });
  });

  describe("generateVerificationToken", () => {
    it("should generate a 64-char hex token", async () => {
      const result = await generateVerificationToken(pool, "user-1");
      expect(result.token).toHaveLength(64);
      expect(result.token).toMatch(/^[a-f0-9]+$/);
    });

    it("should store token and expiry in the database", async () => {
      const result = await generateVerificationToken(pool, "user-1");

      const { rows } = await pg.query(`SELECT verification_token, verification_expires FROM "user" WHERE id = $1`, [
        "user-1",
      ]);
      const row = rows[0] as { verification_token: string; verification_expires: string };

      expect(row.verification_token).toBe(result.token);
      expect(row.verification_expires).toBe(result.expiresAt);
    });

    it("should set expiry 24 hours in the future", async () => {
      const before = Date.now();
      const result = await generateVerificationToken(pool, "user-1");
      const after = Date.now();

      const expiresMs = new Date(result.expiresAt).getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      expect(expiresMs).toBeGreaterThanOrEqual(before + twentyFourHours);
      expect(expiresMs).toBeLessThanOrEqual(after + twentyFourHours);
    });

    it("should overwrite previous token on re-generation", async () => {
      const first = await generateVerificationToken(pool, "user-1");
      const second = await generateVerificationToken(pool, "user-1");

      expect(first.token).not.toBe(second.token);

      const { rows } = await pg.query(`SELECT verification_token FROM "user" WHERE id = $1`, ["user-1"]);
      const row = rows[0] as { verification_token: string };
      expect(row.verification_token).toBe(second.token);
    });
  });

  describe("verifyToken", () => {
    it("should verify a valid token and mark user as verified", async () => {
      const { token } = await generateVerificationToken(pool, "user-1");
      const result = await verifyToken(pool, token);

      expect(result).toEqual({ userId: "user-1", email: "alice@test.com" });

      const { rows } = await pg.query(`SELECT email_verified, verification_token FROM "user" WHERE id = $1`, [
        "user-1",
      ]);
      const row = rows[0] as { email_verified: boolean; verification_token: string | null };
      expect(row.email_verified).toBe(true);
      expect(row.verification_token).toBeNull();
    });

    it("should return null for non-existent token", async () => {
      expect(await verifyToken(pool, "a".repeat(64))).toBeNull();
    });

    it("should return null for empty token", async () => {
      expect(await verifyToken(pool, "")).toBeNull();
    });

    it("should return null for wrong-length token", async () => {
      expect(await verifyToken(pool, "abc")).toBeNull();
    });

    it("should return null for expired token", async () => {
      const { token } = await generateVerificationToken(pool, "user-1");

      await pg.query(`UPDATE "user" SET verification_expires = $1 WHERE id = $2`, [
        new Date(Date.now() - 1000).toISOString(),
        "user-1",
      ]);

      expect(await verifyToken(pool, token)).toBeNull();
    });

    it("should return null for already-verified user", async () => {
      const { token } = await generateVerificationToken(pool, "user-1");
      await pg.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, ["user-1"]);
      expect(await verifyToken(pool, token)).toBeNull();
    });

    it("should only allow single verification per token", async () => {
      const { token } = await generateVerificationToken(pool, "user-1");

      const first = await verifyToken(pool, token);
      const second = await verifyToken(pool, token);

      expect(first).toEqual({ userId: "user-1", email: "alice@test.com" });
      expect(second).toBeNull();
    });
  });

  describe("isEmailVerified", () => {
    it("should return false for unverified user", async () => {
      expect(await isEmailVerified(pool, "user-1")).toBe(false);
    });

    it("should return true after verification", async () => {
      const { token } = await generateVerificationToken(pool, "user-1");
      await verifyToken(pool, token);
      expect(await isEmailVerified(pool, "user-1")).toBe(true);
    });

    it("should return false for non-existent user", async () => {
      expect(await isEmailVerified(pool, "no-such-user")).toBe(false);
    });
  });

  describe("getUserEmail", () => {
    it("should return email for existing user", async () => {
      expect(await getUserEmail(pool, "user-1")).toBe("alice@test.com");
    });

    it("should return null for non-existent user", async () => {
      expect(await getUserEmail(pool, "no-such-user")).toBeNull();
    });
  });
});
