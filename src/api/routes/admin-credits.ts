import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { getAdminAuditLog, getCreditLedger } from "../../fleet/services.js";
import { Credit } from "../../monetization/credit.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import { InsufficientBalanceError } from "../../monetization/credits/credit-ledger.js";

function parseIntParam(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// BOUNDARY(WOP-805): Admin credit REST routes have a tRPC mirror at
// src/trpc/routers/admin.ts (creditsBalance, creditsGrant, creditsRefund,
// creditsCorrection, creditsTransactions, creditsTransactionsExport).
// Keep REST for backwards compatibility until admin UI fully migrates to tRPC.
/**
 * Create admin credit API routes with an explicit ledger.
 * Used in tests to inject a mock ledger.
 */
export function createAdminCreditApiRoutes(ledger: ICreditLedger): Hono<AuthEnv> {
  return buildRoutes(() => ledger);
}

function buildRoutes(ledgerFactory: () => ICreditLedger): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  /** POST /:tenantId/grant */
  routes.post("/:tenantId/grant", async (c) => {
    const ledger = ledgerFactory();
    const tenant = c.req.param("tenantId");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const amountCents = body.amount_cents;
    const reason = body.reason;

    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
      return c.json({ error: "amount_cents must be a positive integer" }, 400);
    }

    if (typeof reason !== "string" || !reason.trim()) {
      return c.json({ error: "reason is required and must be non-empty" }, 400);
    }

    try {
      const user = c.get("user");
      const adminUser = user?.id ?? "unknown";
      let result: Awaited<ReturnType<typeof ledger.credit>>;
      try {
        result = await ledger.credit(tenant, Credit.fromCents(amountCents), "signup_grant", reason);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "credits.grant",
            category: "credits",
            targetTenant: tenant,
            details: { amount_cents: amountCents, reason, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "credits.grant",
          category: "credits",
          targetTenant: tenant,
          details: { amount_cents: amountCents, reason },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** POST /:tenantId/refund */
  routes.post("/:tenantId/refund", async (c) => {
    const ledger = ledgerFactory();
    const tenant = c.req.param("tenantId");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const amountCents = body.amount_cents;
    const reason = body.reason;

    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
      return c.json({ error: "amount_cents must be a positive integer" }, 400);
    }

    if (typeof reason !== "string" || !reason.trim()) {
      return c.json({ error: "reason is required and must be non-empty" }, 400);
    }

    try {
      const user = c.get("user");
      const adminUser = user?.id ?? "unknown";
      let result: Awaited<ReturnType<typeof ledger.credit>>;
      try {
        result = await ledger.credit(tenant, Credit.fromCents(amountCents), "purchase", reason);
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "credits.refund",
            category: "credits",
            targetTenant: tenant,
            details: { amount_cents: amountCents, reason, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "credits.refund",
          category: "credits",
          targetTenant: tenant,
          details: { amount_cents: amountCents, reason },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return c.json({ error: err.message, current_balance: err.currentBalance }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** POST /:tenantId/correction */
  routes.post("/:tenantId/correction", async (c) => {
    const ledger = ledgerFactory();
    const tenant = c.req.param("tenantId");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const amountCents = body.amount_cents;
    const reason = body.reason;

    if (typeof amountCents !== "number" || !Number.isInteger(amountCents)) {
      return c.json({ error: "amount_cents must be an integer" }, 400);
    }

    if (typeof reason !== "string" || !reason.trim()) {
      return c.json({ error: "reason is required and must be non-empty" }, 400);
    }

    try {
      const user = c.get("user");
      const adminUser = user?.id ?? "unknown";
      let result: Awaited<ReturnType<typeof ledger.credit>>;
      try {
        if (amountCents >= 0) {
          result = await ledger.credit(tenant, Credit.fromCents(amountCents || 1), "promo", reason);
        } else {
          result = await ledger.debit(tenant, Credit.fromCents(Math.abs(amountCents)), "correction", reason);
        }
      } catch (err) {
        try {
          getAdminAuditLog().log({
            adminUser,
            action: "credits.correction",
            category: "credits",
            targetTenant: tenant,
            details: { amount_cents: amountCents, reason, error: String(err) },
            outcome: "failure",
          });
        } catch {
          /* audit must not break request */
        }
        throw err;
      }
      try {
        getAdminAuditLog().log({
          adminUser,
          action: "credits.correction",
          category: "credits",
          targetTenant: tenant,
          details: { amount_cents: amountCents, reason },
          outcome: "success",
        });
      } catch {
        /* audit must not break request */
      }
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return c.json({ error: err.message, current_balance: err.currentBalance }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** GET /:tenantId/balance */
  routes.get("/:tenantId/balance", async (c) => {
    const ledger = ledgerFactory();
    const tenant = c.req.param("tenantId");

    try {
      const balance = await ledger.balance(tenant);
      return c.json({ tenant, balance_cents: balance });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  /** GET /:tenantId/transactions */
  routes.get("/:tenantId/transactions", async (c) => {
    const ledger = ledgerFactory();
    const tenant = c.req.param("tenantId");
    const typeParam = c.req.query("type");

    const filters = {
      type: typeParam,
      limit: parseIntParam(c.req.query("limit")),
      offset: parseIntParam(c.req.query("offset")),
    };

    try {
      const entries = await ledger.history(tenant, filters);
      return c.json({ entries, total: entries.length });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  /** GET /:tenantId/adjustments -- alias for transactions */
  routes.get("/:tenantId/adjustments", async (c) => {
    const ledger = ledgerFactory();
    const tenant = c.req.param("tenantId");
    const typeParam = c.req.query("type");

    const filters = {
      type: typeParam,
      limit: parseIntParam(c.req.query("limit")),
      offset: parseIntParam(c.req.query("offset")),
    };

    try {
      const entries = await ledger.history(tenant, filters);
      return c.json({ entries, total: entries.length });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return routes;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin credit routes with auth and lazy ledger initialization. */
export const adminCreditRoutes = new Hono<AuthEnv>();
adminCreditRoutes.use("*", adminAuth);
adminCreditRoutes.route("/", buildRoutes(getCreditLedger));
