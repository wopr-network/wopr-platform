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
import type { Pool } from "pg";
import type { IEmailVerifier } from "./require-verified.js";

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Add email verification columns to the better-auth user table. */
export async function initVerificationSchema(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS verification_token TEXT`);
  await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS verification_expires TEXT`);
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
 */
export async function generateVerificationToken(pool: Pool, userId: string): Promise<VerificationToken> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

  await pool.query(`UPDATE "user" SET verification_token = $1, verification_expires = $2 WHERE id = $3`, [
    token,
    expiresAt,
    userId,
  ]);

  return { token, expiresAt };
}

/**
 * Verify a token: check it exists, hasn't expired, and mark the user as verified.
 */
export async function verifyToken(pool: Pool, token: string): Promise<{ userId: string; email: string } | null> {
  if (!token || token.length !== 64) return null;

  const { rows } = await pool.query(
    `SELECT id, email, verification_token, verification_expires, email_verified FROM "user" WHERE verification_token = $1`,
    [token],
  );

  const row = rows[0];
  if (!row) return null;
  if (row.email_verified === true) return null;

  const expiresAt = new Date(row.verification_expires).getTime();
  if (Date.now() > expiresAt) return null;

  await pool.query(
    `UPDATE "user" SET email_verified = true, verification_token = NULL, verification_expires = NULL WHERE id = $1`,
    [row.id],
  );

  return { userId: row.id, email: row.email };
}

/**
 * Check whether a user has verified their email.
 */
export async function isEmailVerified(pool: Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT email_verified FROM "user" WHERE id = $1`, [userId]);
  return rows[0]?.email_verified === true;
}

/**
 * Get a user's email by their ID.
 */
export async function getUserEmail(pool: Pool, userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT email FROM "user" WHERE id = $1`, [userId]);
  return rows[0]?.email ?? null;
}

/** PostgreSQL-backed implementation of IEmailVerifier for the auth database. */
export class PgEmailVerifier implements IEmailVerifier {
  constructor(private readonly pool: Pool) {}

  async isVerified(userId: string): Promise<boolean> {
    return isEmailVerified(this.pool, userId);
  }
}
