/**
 * Email Verification Route — Handles verification link clicks.
 *
 * GET /auth/verify?token=xxx
 *
 * On success:
 * 1. Marks user email_verified = true
 * 2. Sends welcome email
 * 3. Grants $5 signup credit
 * 4. Redirects to UI with success status
 *
 * On failure:
 * Redirects to UI with error status (invalid/expired token).
 */

import type DatabaseType from "better-sqlite3";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { logger } from "../../config/logger.js";
import { applyPlatformPragmas } from "../../db/pragmas.js";
import { getEmailClient } from "../../email/client.js";
import { welcomeTemplate } from "../../email/templates.js";
import { verifyToken } from "../../email/verification.js";
import { getCreditLedger } from "../../fleet/services.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";

const AUTH_DB_PATH = process.env.AUTH_DB_PATH || "/data/platform/auth.db";
const UI_ORIGIN = process.env.UI_ORIGIN || "http://localhost:3001";
const SIGNUP_CREDIT_CENTS = 500; // $5.00

/** Lazy-initialized auth database. */
let _authDb: DatabaseType.Database | null = null;
function getAuthDb(): DatabaseType.Database {
  if (!_authDb) {
    _authDb = new Database(AUTH_DB_PATH);
    applyPlatformPragmas(_authDb);
  }
  return _authDb;
}

export interface VerifyEmailRouteDeps {
  authDb: DatabaseType.Database;
  creditLedger: ICreditLedger;
}

// BOUNDARY(WOP-805): REST is the correct layer for email verification.
// Users click a link in their email → GET /auth/verify?token=xxx → redirect.
// This is a browser redirect flow, not a JSON RPC call.
/**
 * Create verify-email routes with explicit dependencies (for testing).
 */
export function createVerifyEmailRoutes(deps: VerifyEmailRouteDeps): Hono {
  return buildRoutes(
    () => deps.authDb,
    () => deps.creditLedger,
  );
}

function buildRoutes(authDbFactory: () => DatabaseType.Database, creditLedgerFactory: () => ICreditLedger): Hono {
  const routes = new Hono();

  routes.get("/verify", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.redirect(`${UI_ORIGIN}/auth/verify?status=error&reason=missing_token`);
    }

    const authDb = authDbFactory();
    const result = verifyToken(authDb, token);

    if (!result) {
      return c.redirect(`${UI_ORIGIN}/auth/verify?status=error&reason=invalid_or_expired`);
    }

    // Grant $5 signup credit
    try {
      const ledger = creditLedgerFactory();
      ledger.credit(result.userId, SIGNUP_CREDIT_CENTS, "signup_grant", "Signup verification credit");
      logger.info("Signup credit granted", { userId: result.userId, amountCents: SIGNUP_CREDIT_CENTS });
    } catch (err) {
      logger.error("Failed to grant signup credit", {
        userId: result.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't block verification if credit grant fails
    }

    // Send welcome email
    try {
      const emailClient = getEmailClient();
      const template = welcomeTemplate(result.email);
      await emailClient.send({
        to: result.email,
        ...template,
        userId: result.userId,
        templateName: "welcome",
      });
    } catch (err) {
      logger.error("Failed to send welcome email", {
        userId: result.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't block verification if welcome email fails
    }

    return c.redirect(`${UI_ORIGIN}/auth/verify?status=success`);
  });

  return routes;
}

/** Production routes using lazy-initialized dependencies. */
export const verifyEmailRoutes = buildRoutes(getAuthDb, getCreditLedger);
