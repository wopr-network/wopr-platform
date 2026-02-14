/**
 * Email Verification — Token generation, validation, and verification flow.
 *
 * Manages the signup verification lifecycle:
 * 1. Generate signed token on signup
 * 2. Store token + expiry in the auth database
 * 3. Verify token when user clicks the link
 * 4. Mark user as verified, send welcome email, grant credits
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Add email verification columns to the better-auth user table. */
export function initVerificationSchema(db: Database.Database): void {
  // better-auth creates a "user" table. We add verification columns.
  // Use IF NOT EXISTS pattern for idempotency.
  const columns = db.pragma("table_info(user)") as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("email_verified")) {
    db.exec("ALTER TABLE user ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("verification_token")) {
    db.exec("ALTER TABLE user ADD COLUMN verification_token TEXT");
  }
  if (!columnNames.has("verification_expires")) {
    db.exec("ALTER TABLE user ADD COLUMN verification_expires TEXT");
  }
}

// ---------------------------------------------------------------------------
// Token operations
// ---------------------------------------------------------------------------

export interface VerificationToken {
  token: string;
  expiresAt: string; // ISO-8601
}

/**
 * Generate a verification token and store it against a user.
 *
 * @param db - The auth database
 * @param userId - The user ID to generate a token for
 * @returns The generated token and expiry
 */
export function generateVerificationToken(db: Database.Database, userId: string): VerificationToken {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

  db.prepare("UPDATE user SET verification_token = ?, verification_expires = ? WHERE id = ?").run(
    token,
    expiresAt,
    userId,
  );

  return { token, expiresAt };
}

/**
 * Verify a token: check it exists, hasn't expired, and mark the user as verified.
 *
 * @param db - The auth database
 * @param token - The verification token from the URL
 * @returns The user ID if verification succeeded, or null if invalid/expired
 */
export function verifyToken(db: Database.Database, token: string): { userId: string; email: string } | null {
  if (!token || token.length !== 64) return null; // hex-encoded 32 bytes = 64 chars

  const row = db
    .prepare(
      "SELECT id, email, verification_token, verification_expires, email_verified FROM user WHERE verification_token = ?",
    )
    .get(token) as
    | {
        id: string;
        email: string;
        verification_token: string;
        verification_expires: string;
        email_verified: number;
      }
    | undefined;

  if (!row) return null;

  // Already verified
  if (row.email_verified === 1) return null;

  // Check expiry
  const expiresAt = new Date(row.verification_expires).getTime();
  if (Date.now() > expiresAt) return null;

  // Mark as verified and clear token
  db.prepare(
    "UPDATE user SET email_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?",
  ).run(row.id);

  return { userId: row.id, email: row.email };
}

/**
 * Check whether a user has verified their email.
 *
 * @param db - The auth database
 * @param userId - The user ID to check
 * @returns true if the user's email is verified
 */
export function isEmailVerified(db: Database.Database, userId: string): boolean {
  const row = db.prepare("SELECT email_verified FROM user WHERE id = ?").get(userId) as
    | { email_verified: number }
    | undefined;

  return row?.email_verified === 1;
}

/**
 * Get a user's email by their ID.
 *
 * @param db - The auth database
 * @param userId - The user ID
 * @returns The user's email, or null if not found
 */
export function getUserEmail(db: Database.Database, userId: string): string | null {
  const row = db.prepare("SELECT email FROM user WHERE id = ?").get(userId) as { email: string } | undefined;
  return row?.email ?? null;
}
