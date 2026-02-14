/**
 * Better Auth — Platform auth source of truth.
 *
 * Provides email+password auth, session management, and cookie-based auth
 * for the platform UI. Uses SQLite via better-sqlite3 for persistence.
 *
 * The auth instance is lazily initialized to avoid opening the database
 * at module import time (which breaks tests).
 */

import { type BetterAuthOptions, betterAuth } from "better-auth";
import Database from "better-sqlite3";

const AUTH_DB_PATH = process.env.AUTH_DB_PATH || "/data/platform/auth.db";
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "";
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || "http://localhost:3100";

function authOptions(db?: Database.Database): BetterAuthOptions {
  const database = db ?? new Database(AUTH_DB_PATH);
  if ("pragma" in database && typeof database.pragma === "function") {
    (database as Database.Database).pragma("journal_mode = WAL");
  }
  return {
    database,
    secret: BETTER_AUTH_SECRET,
    baseURL: BETTER_AUTH_URL,
    basePath: "/api/auth",
    emailAndPassword: { enabled: true },
    session: {
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    trustedOrigins: (process.env.UI_ORIGIN || "http://localhost:3001").split(","),
  };
}

/** The type of a better-auth instance. */
export type Auth = ReturnType<typeof betterAuth>;

let _auth: Auth | null = null;

/**
 * Get or create the singleton better-auth instance.
 * Lazily initialized on first call to avoid DB access at import time.
 */
export function getAuth(): Auth {
  if (!_auth) {
    _auth = betterAuth(authOptions());
  }
  return _auth;
}

/**
 * Replace the singleton auth instance (for testing).
 */
export function setAuth(auth: Auth): void {
  _auth = auth;
}

/**
 * Reset the singleton (for testing cleanup).
 */
export function resetAuth(): void {
  _auth = null;
}
