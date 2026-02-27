import { Hono } from "hono";
import { buildTokenMap, scopedBearerAuth } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { getCreditLedger } from "../../fleet/services.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import { checkInstanceQuota, DEFAULT_INSTANCE_LIMITS } from "../../monetization/quotas/quota-check.js";
import { buildResourceLimits, DEFAULT_RESOURCE_CONFIG } from "../../monetization/quotas/resource-limits.js";

const quotaTokenMap = buildTokenMap();

// BOUNDARY(WOP-805): This REST route is a tRPC migration candidate.
// The tRPC usage router already provides quota, quotaCheck, and resourceLimits.
// Once the UI switches to tRPC usage.*, this REST route can be removed.
// Blocker: UI still calls REST /api/quota via bearer token.
export const quotaRoutes = new Hono();

// Quota viewing = admin scope (billing/quota management is an admin operation)
if (quotaTokenMap.size === 0) {
  logger.warn("No API tokens configured — quota routes will reject all requests");
}
quotaRoutes.use("/*", scopedBearerAuth(quotaTokenMap, "admin"));

let _ledger: ICreditLedger | null = null;

function getLedger(): ICreditLedger {
  if (!_ledger) {
    _ledger = getCreditLedger();
  }
  return _ledger;
}

/** Inject a CreditLedger for testing */
export function setLedger(l: ICreditLedger): void {
  _ledger = l;
}

/**
 * GET /quota
 *
 * Returns the authenticated tenant's credit balance and resource limits.
 *
 * Query params:
 *   - tenant: tenant ID (required)
 *   - activeInstances: current instance count (temporary — will come from fleet DB)
 */
quotaRoutes.get("/", async (c) => {
  const tenantId = c.req.query("tenant");
  if (!tenantId) {
    return c.json({ error: "tenant query param is required" }, 400);
  }

  const activeRaw = c.req.query("activeInstances");
  const activeInstances = activeRaw != null ? Number.parseInt(activeRaw, 10) : 0;

  if (Number.isNaN(activeInstances) || activeInstances < 0) {
    return c.json({ error: "Invalid activeInstances parameter" }, 400);
  }

  const balance = await getLedger().balance(tenantId);

  return c.json({
    balanceCents: Math.round(balance.toCents()),
    instances: {
      current: activeInstances,
      max: DEFAULT_INSTANCE_LIMITS.maxInstances,
      remaining:
        DEFAULT_INSTANCE_LIMITS.maxInstances === 0
          ? -1
          : Math.max(0, DEFAULT_INSTANCE_LIMITS.maxInstances - activeInstances),
    },
    resources: DEFAULT_RESOURCE_CONFIG,
  });
});

/**
 * POST /quota/check
 *
 * Check whether an instance creation would be allowed.
 * Body: { tenant: string, activeInstances: number, softCap?: boolean }
 */
quotaRoutes.post("/check", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tenantId = body.tenant as string;
  if (!tenantId) {
    return c.json({ error: "tenant is required" }, 400);
  }

  const activeInstances = Number(body.activeInstances ?? 0);
  const softCap = Boolean(body.softCap);

  if (Number.isNaN(activeInstances) || activeInstances < 0) {
    return c.json({ error: "Invalid activeInstances" }, 400);
  }

  // Check credit balance
  const balance = await getLedger().balance(tenantId);
  if (balance.isNegative() || balance.isZero()) {
    return c.json(
      {
        allowed: false,
        reason: "Insufficient credit balance",
        currentBalanceCents: Math.round(balance.toCents()),
        purchaseUrl: "/settings/billing",
      },
      402,
    );
  }

  const result = checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, activeInstances, {
    softCapEnabled: softCap,
    gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
  });

  const status = result.allowed ? 200 : 403;
  return c.json(result, status);
});

/**
 * GET /quota/balance/:tenant
 *
 * Get a tenant's credit balance.
 */
quotaRoutes.get("/balance/:tenant", async (c) => {
  const tenantId = c.req.param("tenant");
  const balance = await getLedger().balance(tenantId);
  return c.json({ tenantId, balanceCents: Math.round(balance.toCents()) });
});

/**
 * GET /quota/history/:tenant
 *
 * Get a tenant's credit transaction history.
 */
quotaRoutes.get("/history/:tenant", async (c) => {
  const tenantId = c.req.param("tenant");
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");
  const type = c.req.query("type");

  const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : 50;
  const offset = offsetRaw != null ? Number.parseInt(offsetRaw, 10) : 0;

  const transactions = await getLedger().history(tenantId, { limit, offset, type: type || undefined });
  return c.json({ transactions });
});

/**
 * GET /quota/resource-limits
 *
 * Get default Docker resource constraints for bot containers.
 */
quotaRoutes.get("/resource-limits", (c) => {
  const limits = buildResourceLimits();
  return c.json(limits);
});
