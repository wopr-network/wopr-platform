/**
 * Auth — Session management, token verification, and middleware.
 *
 * Provides:
 * - Session creation and validation with configurable TTL
 * - Bearer token verification
 * - `requireAuth` middleware for Hono routes
 * - `requireRole` middleware for role-based access control
 * - `scopedBearerAuth` middleware for operation-scoped API tokens
 */

import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  roles: string[];
}

export interface Session {
  id: string;
  userId: string;
  roles: string[];
  createdAt: number;
  expiresAt: number;
}

export interface AuthConfig {
  /** Session TTL in milliseconds (default: 1 hour) */
  sessionTtlMs?: number;
  /** Static bearer tokens mapped to users (for API key auth) */
  apiTokens?: Map<string, AuthUser>;
}

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

/**
 * In-memory session store.
 *
 * Production deployments should back this with Redis or a database.
 * This implementation is suitable for single-process deployments and testing.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3_600_000) {
    this.ttlMs = ttlMs;
  }

  /** Create a new session for a user. Returns the session object. */
  create(user: AuthUser): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      userId: user.id,
      roles: [...user.roles],
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Validate a session by ID.
   * Returns the session if valid and not expired, or `null` otherwise.
   */
  validate(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  /** Revoke (delete) a session. */
  revoke(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Remove all expired sessions. Returns the number removed. */
  purgeExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Return the number of active (non-expired) sessions. */
  get size(): number {
    return this.sessions.size;
  }
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verify a bearer token against the configured API tokens or session store.
 *
 * Resolution order:
 * 1. Check static API tokens
 * 2. Check session store (token = session ID)
 *
 * Returns the authenticated user or `null`.
 */
export function verifyBearerToken(
  token: string,
  sessionStore: SessionStore,
  apiTokens?: Map<string, AuthUser>,
): AuthUser | null {
  if (!token) return null;

  // 1. Static API token lookup
  if (apiTokens) {
    const user = apiTokens.get(token);
    if (user) return { ...user, roles: [...user.roles] };
  }

  // 2. Session-based lookup
  const session = sessionStore.validate(token);
  if (session) {
    return { id: session.userId, roles: [...session.roles] };
  }

  return null;
}

/**
 * Extract the bearer token from an Authorization header value.
 * Returns `null` if the header is missing, empty, or not a Bearer scheme.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface AuthEnv {
  Variables: {
    user: AuthUser;
    authMethod: "session" | "api_key";
  };
}

/**
 * Create a `requireAuth` middleware that rejects unauthenticated requests.
 *
 * On success, sets:
 * - `c.set("user", { id, roles })`
 * - `c.set("authMethod", "session" | "api_key")`
 */
export function requireAuth(sessionStore: SessionStore, apiTokens?: Map<string, AuthUser>) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Check API tokens first
    if (apiTokens) {
      const apiUser = apiTokens.get(token);
      if (apiUser) {
        c.set("user", { ...apiUser, roles: [...apiUser.roles] });
        c.set("authMethod", "api_key");
        return next();
      }
    }

    // Check session store
    const session = sessionStore.validate(token);
    if (session) {
      c.set("user", { id: session.userId, roles: [...session.roles] });
      c.set("authMethod", "session");
      return next();
    }

    return c.json({ error: "Invalid or expired token" }, 401);
  };
}

/**
 * Create a `requireRole` middleware that rejects users without the specified role.
 * Must be used after `requireAuth`.
 */
export function requireRole(role: string) {
  return async (c: Context<AuthEnv>, next: Next) => {
    let user: AuthUser | undefined;
    try {
      user = c.get("user");
    } catch {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!user.roles.includes(role)) {
      return c.json({ error: "Insufficient permissions", required: role }, 403);
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Scoped API Tokens
// ---------------------------------------------------------------------------

/** Operation scopes ordered by privilege level. */
export type TokenScope = "read" | "write" | "admin";

/** Privilege hierarchy: admin > write > read. */
const SCOPE_LEVEL: Record<TokenScope, number> = {
  read: 0,
  write: 1,
  admin: 2,
};

const VALID_SCOPES = new Set<string>(["read", "write", "admin"]);

/**
 * Parse a token's scope from the `wopr_<scope>_<random>` format.
 *
 * - `wopr_read_abc123`  -> `"read"`
 * - `wopr_write_abc123` -> `"write"`
 * - `wopr_admin_abc123` -> `"admin"`
 * - Any other format    -> `null` (not a scoped token)
 */
export function parseTokenScope(token: string): TokenScope | null {
  if (!token.startsWith("wopr_")) return null;
  const parts = token.split("_");
  // Must be at least 3 parts: "wopr", scope, random
  if (parts.length < 3) return null;
  const scope = parts[1];
  if (!VALID_SCOPES.has(scope)) return null;
  // The random portion (everything after wopr_<scope>_) must be non-empty
  const random = parts.slice(2).join("_");
  if (!random) return null;
  return scope as TokenScope;
}

/**
 * Check whether a token's scope satisfies the required minimum scope.
 * admin >= write >= read.
 */
export function scopeSatisfies(tokenScope: TokenScope, requiredScope: TokenScope): boolean {
  return SCOPE_LEVEL[tokenScope] >= SCOPE_LEVEL[requiredScope];
}

export interface ScopedTokenConfig {
  /**
   * Map of token string -> its scope.
   * Tokens can be in `wopr_<scope>_<random>` format (scope parsed automatically)
   * or plain strings mapped explicitly.
   */
  tokens: Map<string, TokenScope>;
}

/**
 * Build a token-to-scope map from environment variables.
 *
 * Accepts:
 * - `FLEET_API_TOKEN` (legacy single token, treated as admin)
 * - `FLEET_API_TOKEN_READ` (read-scoped token)
 * - `FLEET_API_TOKEN_WRITE` (write-scoped token)
 * - `FLEET_API_TOKEN_ADMIN` (admin-scoped token)
 * - Any `wopr_<scope>_<random>` formatted token has its scope inferred.
 */
export function buildTokenMap(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Map<string, TokenScope> {
  const tokens = new Map<string, TokenScope>();

  // Scoped env vars
  const scopedVars: [string, TokenScope][] = [
    ["FLEET_API_TOKEN_READ", "read"],
    ["FLEET_API_TOKEN_WRITE", "write"],
    ["FLEET_API_TOKEN_ADMIN", "admin"],
  ];

  for (const [envVar, scope] of scopedVars) {
    const val = env[envVar]?.trim();
    if (val) tokens.set(val, scope);
  }

  // Legacy single token -- admin scope for backwards compatibility
  const legacyToken = env.FLEET_API_TOKEN?.trim();
  if (legacyToken && !tokens.has(legacyToken)) {
    // If the token is in wopr_ format, parse its actual scope
    const parsed = parseTokenScope(legacyToken);
    tokens.set(legacyToken, parsed ?? "admin");
  }

  return tokens;
}

/**
 * Create a scoped bearer auth middleware.
 *
 * Validates the bearer token against the token map and checks that the
 * token's scope satisfies the required minimum scope for the route.
 *
 * @param tokenMap - Map of token -> scope (use `buildTokenMap()` to create)
 * @param requiredScope - Minimum scope required for this route/group
 */
export function scopedBearerAuth(tokenMap: Map<string, TokenScope>, requiredScope: TokenScope) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Look up the token in the map
    const scope = tokenMap.get(token);

    // If not in map, try to parse scope from token format for dynamic tokens
    if (scope === undefined) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // Check scope hierarchy
    if (!scopeSatisfies(scope, requiredScope)) {
      return c.json({ error: "Insufficient scope", required: requiredScope, provided: scope }, 403);
    }

    return next();
  };
}
