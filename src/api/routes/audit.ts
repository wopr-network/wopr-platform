import Database from "better-sqlite3";
import type { Context } from "hono";
import { Hono } from "hono";
import { DrizzleAuditLogRepository, type IAuditLogRepository } from "../../audit/audit-log-repository.js";
import { countAuditLog, queryAuditLog } from "../../audit/query.js";
import { purgeExpiredEntriesForUser } from "../../audit/retention.js";
import type { AuditEnv } from "../../audit/types.js";
import type { DrizzleDb } from "../../db/index.js";
import { createDb } from "../../db/index.js";
import { applyPlatformPragmas } from "../../db/pragmas.js";

const AUDIT_DB_PATH = process.env.AUDIT_DB_PATH || "/data/platform/audit.db";

/** Lazy-initialized audit repository (avoids opening DB at module load time). */
let _auditRepo: IAuditLogRepository | null = null;
function getAuditRepo(): IAuditLogRepository {
  if (!_auditRepo) {
    const sqlite = new Database(AUDIT_DB_PATH);
    applyPlatformPragmas(sqlite);
    _auditRepo = new DrizzleAuditLogRepository(createDb(sqlite));
  }
  return _auditRepo;
}

/** Inject an audit repository for testing. */
export function setAuditDb(db: DrizzleDb): void {
  _auditRepo = new DrizzleAuditLogRepository(db);
}

function handleUserAudit(c: Context<AuditEnv>, repo: IAuditLogRepository) {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  purgeExpiredEntriesForUser(repo, user.id);

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
    const entries = queryAuditLog(repo, filters);
    const total = countAuditLog(repo, filters);
    return c.json({ entries, total });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
}

function handleAdminAudit(c: Context<AuditEnv>, repo: IAuditLogRepository) {
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
    const entries = queryAuditLog(repo, filters);
    const total = countAuditLog(repo, filters);
    return c.json({ entries, total });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * Create audit log API routes with an explicit database.
 *
 * Expects `c.get("user")` to provide `{ id: string }`.
 */
export function createAuditRoutes(db: DrizzleDb): Hono<AuditEnv> {
  const repo = new DrizzleAuditLogRepository(db);
  const routes = new Hono<AuditEnv>();
  routes.get("/", (c) => handleUserAudit(c, repo));
  return routes;
}

/**
 * Create admin audit log API routes with an explicit database.
 *
 * Expects `c.get("user")` to provide `{ id: string, isAdmin: boolean }`.
 */
export function createAdminAuditRoutes(db: DrizzleDb): Hono<AuditEnv> {
  const repo = new DrizzleAuditLogRepository(db);
  const routes = new Hono<AuditEnv>();
  routes.get("/", (c) => handleAdminAudit(c, repo));
  return routes;
}

// BOUNDARY(WOP-805): This REST route is a tRPC migration candidate.
// The UI calls GET /api/audit via session cookie for user audit log.
// The admin version (adminAuditRoutes) already has a tRPC mirror at admin.auditLog.
// Blocker: need to add a user-scoped tRPC audit procedure (admin.auditLog is admin-only).
/** Pre-built audit routes with lazy DB initialization. */
export const auditRoutes = new Hono<AuditEnv>();
auditRoutes.get("/", (c) => handleUserAudit(c, getAuditRepo()));

/** Pre-built admin audit routes with lazy DB initialization. */
export const adminAuditRoutes = new Hono<AuditEnv>();
adminAuditRoutes.get("/", (c) => handleAdminAudit(c, getAuditRepo()));
