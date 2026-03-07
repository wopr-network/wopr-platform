import type { PGlite } from "@electric-sql/pglite";

/**
 * Minimal pg.Pool-compatible interface for better-auth's Kysely PostgresDialect.
 */
export interface PoolLike {
  connect: () => Promise<{ query: (text: string, params?: unknown[]) => Promise<unknown>; release: () => void }>;
  query: (text: string, params?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
}

/**
 * Wrap a PGlite instance as a pg.Pool-compatible object for better-auth.
 */
export function pgliteAsPool(pg: PGlite): PoolLike {
  const client = {
    query: (text: string, params?: unknown[]) => pg.query(text, params),
    release: () => {},
  };
  return {
    connect: () => Promise.resolve(client),
    query: (text: string, params?: unknown[]) => pg.query(text, params),
    end: () => Promise.resolve(),
  };
}

/**
 * Create the better-auth base schema tables in PGlite.
 * Replaces getMigrations() which requires a Kysely adapter not compatible with PGlite.
 */
export async function initBetterAuthSchema(pg: PGlite): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL DEFAULT false,
      "image" text,
      "twoFactorEnabled" boolean NOT NULL DEFAULT false,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY NOT NULL,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      "scope" text,
      "password" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz,
      "updatedAt" timestamptz
    )
  `);
}
