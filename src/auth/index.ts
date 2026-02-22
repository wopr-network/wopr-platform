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
import type { ISessionRepository } from "./session-repository.js";

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
 * DB-backed session store.
 *
 * Delegates all persistence to the injected ISessionRepository.
 * Maintains the same public API as the old in-memory SessionStore
 * so existing consumers don't need updating.
 */
export class SessionStore {
  private readonly repo: ISessionRepository;
  private readonly ttlMs: number;

  constructor(repo: ISessionRepository, ttlMs = 3_600_000) {
    this.repo = repo;
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
    this.repo.create(session);
    return session;
  }

  /**
   * Validate a session by ID.
   * Returns the session if valid and not expired, or `null` otherwise.
   */
  validate(sessionId: string): Session | null {
    const record = this.repo.validate(sessionId);
    if (!record) return null;
    return record;
  }

  /** Revoke (delete) a session. */
  revoke(sessionId: string): boolean {
    return this.repo.revoke(sessionId);
  }

  /** Remove all expired sessions. Returns the number removed. */
  purgeExpired(): number {
    return this.repo.purgeExpired();
  }

  /** Return the number of active (non-expired) sessions. */
  get size(): number {
    return this.repo.size;
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
    tokenTenantId?: string;
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

/** Token metadata including scope and tenant association. */
export interface TokenMetadata {
  scope: TokenScope;
  tenantId?: string;
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
 * Build a token-to-metadata map from environment variables.
 *
 * Accepts:
 * - `FLEET_TOKEN_<TENANT>=<scope>:<token>` (tenant-scoped tokens)
 * - Fallback to legacy token map for backwards compatibility (no tenant constraint)
 *
 * Example: `FLEET_TOKEN_ACME=write:wopr_write_abc123`
 */
export function buildTokenMetadataMap(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Map<string, TokenMetadata> {
  const metadataMap = new Map<string, TokenMetadata>();

  // Parse FLEET_TOKEN_<TENANT>=<scope>:<token> format
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("FLEET_TOKEN_") && value) {
      const tenantId = key.slice("FLEET_TOKEN_".length);
      if (!tenantId) continue;

      const trimmed = value.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const scopeStr = trimmed.slice(0, colonIdx);
      const token = trimmed.slice(colonIdx + 1);

      if (!VALID_SCOPES.has(scopeStr) || !token) continue;

      metadataMap.set(token, {
        scope: scopeStr as TokenScope,
        tenantId,
      });
    }
  }

  // Fallback: add legacy tokens without tenant constraint
  const legacyTokenMap = buildTokenMap(env);
  for (const [token, scope] of legacyTokenMap) {
    if (!metadataMap.has(token)) {
      metadataMap.set(token, { scope });
    }
  }

  return metadataMap;
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

    // Set user context for downstream middleware (audit, etc.)
    c.set("user", { id: `token:${scope}`, roles: [scope] } satisfies AuthUser);
    c.set("authMethod", "api_key" as const);

    return next();
  };
}

/**
 * Create a tenant-aware scoped bearer auth middleware.
 *
 * Validates the bearer token against the metadata map, checks scope,
 * and stores the token's associated tenantId for downstream ownership checks.
 *
 * @param metadataMap - Map of token -> metadata (use `buildTokenMetadataMap()` to create)
 * @param requiredScope - Minimum scope required for this route/group
 */
export function scopedBearerAuthWithTenant(metadataMap: Map<string, TokenMetadata>, requiredScope: TokenScope) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Look up the token in the metadata map
    const metadata = metadataMap.get(token);

    if (!metadata) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // Check scope hierarchy
    if (!scopeSatisfies(metadata.scope, requiredScope)) {
      return c.json({ error: "Insufficient scope", required: requiredScope, provided: metadata.scope }, 403);
    }

    // Set user context for downstream middleware (audit, etc.)
    c.set("user", { id: `token:${metadata.scope}`, roles: [metadata.scope] } satisfies AuthUser);
    c.set("authMethod", "api_key" as const);

    // Store tenant ID if associated with this token
    if (metadata.tenantId) {
      c.set("tokenTenantId", metadata.tenantId);
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Session Resolution (better-auth)
// ---------------------------------------------------------------------------

/**
 * Middleware that resolves the current user from a better-auth session cookie.
 *
 * On success, sets:
 * - `c.set("user", { id, roles })`
 * - `c.set("authMethod", "session")`
 *
 * If no session cookie is present (or session is invalid), the request
 * continues without a user — downstream middleware like `scopedBearerAuth`
 * or `requireAuth` will handle enforcement.
 *
 * Uses lazy `getAuth()` to avoid initializing the DB at import time.
 */
export function resolveSessionUser() {
  return async (c: Context, next: Next) => {
    // Skip if user is already set (e.g., by scopedBearerAuth)
    try {
      if (c.get("user")) return next();
    } catch {
      // c.get throws if variable not set — that's fine, continue
    }

    try {
      const { getAuth } = await import("./better-auth.js");
      const auth = getAuth();
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const user = session.user as { id: string; role?: string };
        const roles: string[] = [];
        if (user.role) roles.push(user.role);
        c.set("user", { id: user.id, roles } satisfies AuthUser);
        c.set("authMethod", "session" as const);
      }
    } catch {
      // Session resolution failed — continue without user
    }

    return next();
  };
}

/**
 * Middleware that requires either a valid session or a scoped API token.
 *
 * Tries session first, then falls back to scoped bearer auth.
 * Returns 401 if neither is present.
 */
export function requireSessionOrToken(tokenMap: Map<string, TokenScope>, requiredScope: TokenScope) {
  return async (c: Context, next: Next) => {
    // Check if user was already resolved by resolveSessionUser
    try {
      if (c.get("user")) return next();
    } catch {
      // Not set — continue to check bearer token
    }

    // Fall back to scoped bearer auth
    const authHeader = c.req.header("Authorization");
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const scope = tokenMap.get(token);
    if (scope === undefined) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    if (!scopeSatisfies(scope, requiredScope)) {
      return c.json({ error: "Insufficient scope", required: requiredScope, provided: scope }, 403);
    }

    c.set("user", { id: `token:${scope}`, roles: [scope] } satisfies AuthUser);
    c.set("authMethod", "api_key" as const);

    return next();
  };
}

// ---------------------------------------------------------------------------
// Tenant Ownership Validation
// ---------------------------------------------------------------------------

/**
 * Middleware that enforces tenant ownership on tenant-scoped resources.
 *
 * Must be used after `scopedBearerAuthWithTenant` middleware.
 * Compares the resource's tenantId against the token's tenantId.
 * - If token has no tenantId (legacy/admin tokens), passes through.
 * - If resource tenantId matches token tenantId, passes through.
 * - Otherwise, returns 403 Forbidden.
 *
 * @param _getResourceTenantId - Function that extracts tenantId from the resource (reserved for future use)
 */
export function requireTenantOwnership<T>(_getResourceTenantId: (resource: T) => string | undefined) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const tokenTenantId = c.get("tokenTenantId");

    // If token has no tenant constraint (legacy/admin token), allow access
    if (!tokenTenantId) {
      return next();
    }

    // Resource tenantId will be validated by route handler
    // Store tokenTenantId for route to check
    return next();
  };
}

/**
 * Validate that a resource belongs to the authenticated tenant.
 * Returns a response if validation fails (404 for not found or tenant mismatch).
 *
 * @param c - Hono context
 * @param resource - The resource to check (null/undefined = not found)
 * @param resourceTenantId - The resource's tenantId
 * @returns Response if validation fails, undefined if validation passes
 */
export function validateTenantOwnership<T>(
  c: Context,
  resource: T | null | undefined,
  resourceTenantId: string | undefined,
): Response | undefined {
  // Resource not found
  if (resource == null) {
    return c.json({ error: "Resource not found" }, 404);
  }

  // Get token's tenant constraint
  let tokenTenantId: string | undefined;
  try {
    tokenTenantId = c.get("tokenTenantId");
  } catch {
    // No tokenTenantId set — this is a legacy/admin token
    tokenTenantId = undefined;
  }

  // No tenant constraint (legacy/admin token) — allow access
  if (!tokenTenantId) {
    return undefined;
  }

  // Validate tenant match
  if (resourceTenantId !== tokenTenantId) {
    return c.json({ error: "Resource not found" }, 404);
  }

  return undefined;
}
