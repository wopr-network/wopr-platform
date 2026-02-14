/**
 * Email Verification Middleware — Blocks actions until email is verified.
 *
 * When used after session auth middleware, checks that the authenticated user
 * has verified their email. API token auth (machine-to-machine) is not subject
 * to email verification and is always allowed through.
 */

import type Database from "better-sqlite3";
import type { Context, Next } from "hono";
import { logger } from "../config/logger.js";
import { isEmailVerified } from "./verification.js";

/**
 * Create middleware that blocks session-authenticated users who haven't verified their email.
 *
 * API token auth (authMethod === "api_key") bypasses this check since machine
 * clients don't have email addresses to verify.
 *
 * @param getAuthDb - Factory function to get the auth database
 */
export function requireEmailVerified(getAuthDb: () => Database.Database) {
  return async (c: Context, next: Next) => {
    let authMethod: string | undefined;
    let userId: string | undefined;

    try {
      authMethod = c.get("authMethod");
      const user = c.get("user") as { id: string } | undefined;
      userId = user?.id;
    } catch {
      // No auth context set — let downstream auth middleware handle 401
      return next();
    }

    // API token auth bypasses email verification
    if (authMethod === "api_key") {
      return next();
    }

    // Session auth requires verified email
    if (authMethod === "session" && userId) {
      try {
        const authDb = getAuthDb();
        if (!isEmailVerified(authDb, userId)) {
          return c.json(
            {
              error: "Email verification required",
              message: "Please verify your email address before creating bots",
              code: "EMAIL_NOT_VERIFIED",
            },
            403,
          );
        }
      } catch (error) {
        // If we can't check verification (DB issue), don't block the user
        logger.warn("Email verification check failed", { error });
      }
    }

    return next();
  };
}
