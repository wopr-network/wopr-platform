/**
 * Session Auth Middleware — Resolves better-auth sessions for Hono routes.
 *
 * Reads the better-auth session cookie from the request, resolves the user,
 * and sets `c.set("user", ...)` and `c.set("authMethod", "session")` for
 * downstream route handlers.
 *
 * This middleware supports a dual-auth model:
 * - **Session auth** (cookie-based): For browser/UI clients via better-auth
 * - **Bearer token auth** (header-based): For machine-to-machine / API key access
 *
 * If neither is present, the request is rejected with 401.
 */

import type { Context, Next } from "hono";
import type { Auth } from "./better-auth.js";
import type { AuthUser } from "./index.js";

export interface SessionAuthEnv {
  Variables: {
    user: AuthUser;
    authMethod: "session" | "api_key";
  };
}

/**
 * Create middleware that authenticates requests via better-auth session cookies.
 *
 * On success, sets:
 * - `c.set("user", { id, roles })` — user context for downstream routes
 * - `c.set("authMethod", "session")` — indicates session-based auth
 *
 * If no valid session cookie is found, returns 401.
 *
 * @param auth - The better-auth instance (use `getAuth()`)
 */
export function sessionAuth(auth: Auth) {
  return async (c: Context<SessionAuthEnv>, next: Next) => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });

      if (!session?.user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const sessionUser = session.user as { id: string; role?: string };
      const user: AuthUser = {
        id: sessionUser.id,
        roles: sessionUser.role === "admin" ? ["admin", "user"] : ["user"],
      };

      c.set("user", user);
      c.set("authMethod", "session");
      return next();
    } catch {
      return c.json({ error: "Authentication failed" }, 401);
    }
  };
}

/**
 * Create dual-auth middleware that accepts EITHER a better-auth session cookie
 * OR a bearer token. Session cookies are checked first; if absent, falls back
 * to bearer token validation.
 *
 * This allows both browser clients (cookies) and machine clients (bearer tokens)
 * to access the same routes.
 *
 * @param auth - The better-auth instance
 * @param apiTokens - Optional map of static API tokens to users
 */
export function dualAuth(auth: Auth, apiTokens?: Map<string, AuthUser>) {
  return async (c: Context<SessionAuthEnv>, next: Next) => {
    // 1. Try session cookie first
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const sessionUser = session.user as { id: string; role?: string };
        const user: AuthUser = {
          id: sessionUser.id,
          roles: sessionUser.role === "admin" ? ["admin", "user"] : ["user"],
        };
        c.set("user", user);
        c.set("authMethod", "session");
        return next();
      }
    } catch {
      // Session check failed, fall through to bearer token
    }

    // 2. Fall back to bearer token
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const trimmed = authHeader.trim();
      if (trimmed.toLowerCase().startsWith("bearer ")) {
        const token = trimmed.slice(7).trim();
        if (token && apiTokens) {
          const apiUser = apiTokens.get(token);
          if (apiUser) {
            c.set("user", { ...apiUser, roles: [...apiUser.roles] });
            c.set("authMethod", "api_key");
            return next();
          }
        }
      }
    }

    return c.json({ error: "Authentication required" }, 401);
  };
}
