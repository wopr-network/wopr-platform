import Database from "better-sqlite3";
import type { Context } from "hono";
import { Hono } from "hono";
import { countAuditLog, queryAuditLog } from "../../audit/query.js";
import { purgeExpiredEntriesForUser } from "../../audit/retention.js";
import { initAuditSchema } from "../../audit/schema.js";
import type { AuditEnv } from "../../audit/types.js";

const AUDIT_DB_PATH = process.env.AUDIT_DB_PATH || "/data/platform/audit.db";

/** Lazy-initialized audit database (avoids opening DB at module load time). */
let _auditDb: Database.Database | null = null;
function getAuditDb(): Database.Database {
  if (!_auditDb) {
    _auditDb = new Database(AUDIT_DB_PATH);
    _auditDb.pragma("journal_mode = WAL");
    initAuditSchema(_auditDb);
  }
  return _auditDb;
}

/** Inject an audit database for testing. */
export function setAuditDb(db: Database.Database): void {
  _auditDb = db;
}

function handleUserAudit(c: Context<AuditEnv>, db: Database.Database) {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const tier = user.tier ?? "free";
  purgeExpiredEntriesForUser(db, user.id, tier);

  const sinceRaw = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const untilRaw = c.req.query("until") ? Number(c.req.query("until")) : undefined;
  const limitRaw = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const offsetRaw = c.req.query("offset") ? Number(c.req.query("offset")) : undefined;

  const filters = {
    userId: user.id,
    action: c.req.query("action") ?? undefined,
    resourceType: c.req.query("resourceType") ?? undefined,
    resourceId: c.req.query("resourceId") ?? undefined,
    since: sinceRaw !== undefined && Number.isFinite(sinceRaw) ? sinceRaw : undefined,
    until: untilRaw !== undefined && Number.isFinite(untilRaw) ? untilRaw : undefined,
    limit: limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : undefined,
    offset: offsetRaw !== undefined && Number.isFinite(offsetRaw) ? offsetRaw : undefined,
  };

  try {
    const entries = queryAuditLog(db, filters);
    const total = countAuditLog(db, filters);
    return c.json({ entries, total });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
}

function handleAdminAudit(c: Context<AuditEnv>, db: Database.Database) {
  const user = c.get("user");
  if (!user?.isAdmin) return c.json({ error: "Forbidden" }, 403);

  const sinceRaw = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const untilRaw = c.req.query("until") ? Number(c.req.query("until")) : undefined;
  const limitRaw = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const offsetRaw = c.req.query("offset") ? Number(c.req.query("offset")) : undefined;

  const filters = {
    userId: c.req.query("userId") ?? undefined,
    action: c.req.query("action") ?? undefined,
    resourceType: c.req.query("resourceType") ?? undefined,
    resourceId: c.req.query("resourceId") ?? undefined,
    since: sinceRaw !== undefined && Number.isFinite(sinceRaw) ? sinceRaw : undefined,
    until: untilRaw !== undefined && Number.isFinite(untilRaw) ? untilRaw : undefined,
    limit: limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : undefined,
    offset: offsetRaw !== undefined && Number.isFinite(offsetRaw) ? offsetRaw : undefined,
  };

  try {
    const entries = queryAuditLog(db, filters);
    const total = countAuditLog(db, filters);
    return c.json({ entries, total });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * Create audit log API routes with an explicit database.
 *
 * Expects `c.get("user")` to provide `{ id: string, tier?: Tier }`.
 */
export function createAuditRoutes(db: Database.Database): Hono<AuditEnv> {
  const routes = new Hono<AuditEnv>();
  routes.get("/", (c) => handleUserAudit(c, db));
  return routes;
}

/**
 * Create admin audit log API routes with an explicit database.
 *
 * Expects `c.get("user")` to provide `{ id: string, isAdmin: boolean }`.
 */
export function createAdminAuditRoutes(db: Database.Database): Hono<AuditEnv> {
  const routes = new Hono<AuditEnv>();
  routes.get("/", (c) => handleAdminAudit(c, db));
  return routes;
}

/** Pre-built audit routes with lazy DB initialization. */
export const auditRoutes = new Hono<AuditEnv>();
auditRoutes.get("/", (c) => handleUserAudit(c, getAuditDb()));

/** Pre-built admin audit routes with lazy DB initialization. */
export const adminAuditRoutes = new Hono<AuditEnv>();
adminAuditRoutes.get("/", (c) => handleAdminAudit(c, getAuditDb()));
