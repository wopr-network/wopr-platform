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

import { logger } from "@wopr-network/platform-core/config/logger";
import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import { grantSignupCredits } from "@wopr-network/platform-core/credits";
import { verifyToken, welcomeTemplate } from "@wopr-network/platform-core/email";
import { getEmailClient } from "@wopr-network/platform-core/email/client";
import { getPool } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import type { Pool } from "pg";
import { getCreditLedger } from "../../platform-services.js";

const UI_ORIGIN = process.env.UI_ORIGIN || "http://localhost:3001";

export interface VerifyEmailRouteDeps {
  pool: Pool;
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
    () => deps.pool,
    () => deps.creditLedger,
  );
}

function buildRoutes(poolFactory: () => Pool, creditLedgerFactory: () => ICreditLedger): Hono {
  const routes = new Hono();

  routes.get("/verify", async (c) => {
    const token = c.req.query("token");

    if (!token) {
      return c.redirect(`${UI_ORIGIN}/auth/verify?status=error&reason=missing_token`);
    }

    const pool = poolFactory();
    const result = await verifyToken(pool, token);

    if (!result) {
      return c.redirect(`${UI_ORIGIN}/auth/verify?status=error&reason=invalid_or_expired`);
    }

    // Grant $5 signup credit (idempotent — safe on link re-click)
    try {
      const ledger = creditLedgerFactory();
      const granted = await grantSignupCredits(ledger, result.userId);
      if (granted) {
        logger.info("Signup credit granted", { userId: result.userId });
      } else {
        logger.info("Signup credit already granted, skipping", { userId: result.userId });
      }
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
export const verifyEmailRoutes = buildRoutes(getPool, getCreditLedger);
