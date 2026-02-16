import Database from "better-sqlite3";
import { Hono } from "hono";
import { buildTokenMap, scopedBearerAuth } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { createDb } from "../../db/index.js";
import type { CreditRepository } from "../../domain/repositories/credit-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { DrizzleCreditRepository } from "../../infrastructure/persistence/drizzle-credit-repository.js";
import { checkInstanceQuota, DEFAULT_INSTANCE_LIMITS } from "../../monetization/quotas/quota-check.js";
import { buildResourceLimits, DEFAULT_RESOURCE_CONFIG } from "../../monetization/quotas/resource-limits.js";

const DB_PATH = process.env.BILLING_DB_PATH || "/data/platform/billing.db";
const quotaTokenMap = buildTokenMap();

export const quotaRoutes = new Hono();

// Quota viewing = admin scope (billing/quota management is an admin operation)
if (quotaTokenMap.size === 0) {
  logger.warn("No API tokens configured — quota routes will reject all requests");
}
quotaRoutes.use("/*", scopedBearerAuth(quotaTokenMap, "admin"));

let creditRepo: CreditRepository | null = null;

function getCreditRepo(): CreditRepository {
  if (!creditRepo) {
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    creditRepo = new DrizzleCreditRepository(createDb(db));
  }
  return creditRepo;
}

/** Inject a CreditRepository for testing */
export function setLedger(l: CreditRepository): void {
  creditRepo = l;
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

  const balance = (await getCreditRepo().getBalance(TenantId.create(tenantId))).balance.toCents();

  return c.json({
    balanceCents: balance,
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
  const balance = (await getCreditRepo().getBalance(TenantId.create(tenantId))).balance.toCents();
  if (balance <= 0) {
    return c.json(
      {
        allowed: false,
        reason: "Insufficient credit balance",
        currentBalanceCents: balance,
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
  const balance = (await getCreditRepo().getBalance(TenantId.create(tenantId))).balance.toCents();
  return c.json({ tenantId, balanceCents: balance });
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

  const result = await getCreditRepo().getTransactionHistory(TenantId.create(tenantId), {
    limit,
    offset,
    type: type || undefined,
  });
  return c.json({
    transactions: result.transactions.map((t) => t.toJSON()),
    totalCount: result.totalCount,
    hasMore: result.hasMore,
  });
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
