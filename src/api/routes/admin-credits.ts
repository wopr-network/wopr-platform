import type DatabaseType from "better-sqlite3";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { initCreditAdjustmentSchema } from "../../admin/credits/schema.js";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import * as dbSchema from "../../db/schema/index.js";
import type {
  AdjustmentType,
  CreditAdjustmentRepository,
} from "../../domain/repositories/credit-adjustment-repository.js";
import {
  BalanceError,
  DrizzleCreditAdjustmentRepository,
} from "../../infrastructure/persistence/drizzle-credit-adjustment-repository.js";

const CREDITS_DB_PATH = process.env.CREDITS_DB_PATH || "/data/platform/credits.db";
const VALID_ADJUSTMENT_TYPES: AdjustmentType[] = ["grant", "refund", "correction"];

/** Lazy-initialized credits database (avoids opening DB at module load time). */
let _creditsDb: DatabaseType.Database | null = null;
function getCreditsDb(): DatabaseType.Database {
  if (!_creditsDb) {
    _creditsDb = new Database(CREDITS_DB_PATH);
    _creditsDb.pragma("journal_mode = WAL");
    initCreditAdjustmentSchema(_creditsDb);
  }
  return _creditsDb;
}

let _repo: CreditAdjustmentRepository | null = null;
function getRepo(): CreditAdjustmentRepository {
  if (!_repo) {
    const drizzleDb = drizzle(getCreditsDb(), { schema: dbSchema });
    _repo = new DrizzleCreditAdjustmentRepository(drizzleDb);
  }
  return _repo;
}

function parseIntParam(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Create admin credit API routes with an explicit database.
 * Used in tests to inject an in-memory database.
 */
export function createAdminCreditApiRoutes(db: DatabaseType.Database): Hono<AuthEnv> {
  initCreditAdjustmentSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });
  const repo = new DrizzleCreditAdjustmentRepository(drizzleDb);
  return buildRoutes(() => repo);
}

function buildRoutes(repoFactory: () => CreditAdjustmentRepository): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  /** POST /:tenantId/grant */
  routes.post("/:tenantId/grant", async (c) => {
    const repo = repoFactory();
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
      const adjustment = await repo.grant(tenant, amountCents, reason, user?.id ?? "unknown");
      return c.json(adjustment, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** POST /:tenantId/refund */
  routes.post("/:tenantId/refund", async (c) => {
    const repo = repoFactory();
    const tenant = c.req.param("tenantId");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const amountCents = body.amount_cents;
    const reason = body.reason;
    const referenceIds = body.reference_ids;

    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
      return c.json({ error: "amount_cents must be a positive integer" }, 400);
    }

    if (typeof reason !== "string" || !reason.trim()) {
      return c.json({ error: "reason is required and must be non-empty" }, 400);
    }

    if (
      referenceIds !== undefined &&
      (!Array.isArray(referenceIds) || !referenceIds.every((id) => typeof id === "string"))
    ) {
      return c.json({ error: "reference_ids must be an array of strings" }, 400);
    }

    try {
      const user = c.get("user");
      const adjustment = await repo.refund(
        tenant,
        amountCents,
        reason,
        user?.id ?? "unknown",
        referenceIds as string[] | undefined,
      );
      return c.json(adjustment, 201);
    } catch (err) {
      if (err instanceof BalanceError) {
        return c.json({ error: err.message, current_balance: err.currentBalance }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** POST /:tenantId/correction */
  routes.post("/:tenantId/correction", async (c) => {
    const repo = repoFactory();
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
      const adjustment = await repo.correction(tenant, amountCents, reason, user?.id ?? "unknown");
      return c.json(adjustment, 201);
    } catch (err) {
      if (err instanceof BalanceError) {
        return c.json({ error: err.message, current_balance: err.currentBalance }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /** GET /:tenantId/balance */
  routes.get("/:tenantId/balance", async (c) => {
    const repo = repoFactory();
    const tenant = c.req.param("tenantId");

    try {
      const balance = await repo.getBalance(tenant);
      return c.json({ tenant, balance_cents: balance });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  /** GET /:tenantId/transactions */
  routes.get("/:tenantId/transactions", async (c) => {
    const repo = repoFactory();
    const tenant = c.req.param("tenantId");
    const typeParam = c.req.query("type");

    if (typeParam !== undefined && !VALID_ADJUSTMENT_TYPES.includes(typeParam as AdjustmentType)) {
      return c.json({ error: `Invalid type: must be one of ${VALID_ADJUSTMENT_TYPES.join(", ")}` }, 400);
    }

    const filters = {
      type: typeParam as AdjustmentType | undefined,
      from: parseIntParam(c.req.query("from")),
      to: parseIntParam(c.req.query("to")),
      limit: parseIntParam(c.req.query("limit")),
      offset: parseIntParam(c.req.query("offset")),
    };

    try {
      const result = await repo.listTransactions(tenant, filters);
      return c.json(result);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  /** GET /:tenantId/adjustments -- alias for transactions */
  routes.get("/:tenantId/adjustments", async (c) => {
    const repo = repoFactory();
    const tenant = c.req.param("tenantId");
    const typeParam = c.req.query("type");

    if (typeParam !== undefined && !VALID_ADJUSTMENT_TYPES.includes(typeParam as AdjustmentType)) {
      return c.json({ error: `Invalid type: must be one of ${VALID_ADJUSTMENT_TYPES.join(", ")}` }, 400);
    }

    const filters = {
      type: typeParam as AdjustmentType | undefined,
      from: parseIntParam(c.req.query("from")),
      to: parseIntParam(c.req.query("to")),
      limit: parseIntParam(c.req.query("limit")),
      offset: parseIntParam(c.req.query("offset")),
    };

    try {
      const result = await repo.listTransactions(tenant, filters);
      return c.json(result);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return routes;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin credit routes with auth and lazy DB initialization. */
export const adminCreditRoutes = new Hono<AuthEnv>();
adminCreditRoutes.use("*", adminAuth);
adminCreditRoutes.route("/", buildRoutes(getRepo));
