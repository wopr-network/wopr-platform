import type Database from "better-sqlite3";
import { Hono } from "hono";
import { countAuditLog, queryAuditLog } from "../../audit/query.js";
import { purgeExpiredEntriesForUser } from "../../audit/retention.js";
import type { AuditEnv } from "../../audit/types.js";

/**
 * Create audit log API routes.
 *
 * Expects `c.get("user")` to provide `{ id: string, tier?: Tier }`.
 */
export function createAuditRoutes(db: Database.Database): Hono<AuditEnv> {
  const routes = new Hono<AuditEnv>();

  /**
   * GET /audit -- User's own audit log.
   * Query params: action, resourceType, resourceId, since, until, limit, offset
   */
  routes.get("/", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    // Run retention cleanup on query (lazy purge)
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
  });

  return routes;
}

/**
 * Create admin audit log API routes.
 *
 * Expects `c.get("user")` to provide `{ id: string, isAdmin: boolean }`.
 */
export function createAdminAuditRoutes(db: Database.Database): Hono<AuditEnv> {
  const routes = new Hono<AuditEnv>();

  /**
   * GET /admin/audit -- Admin: any user's audit log.
   * Query params: userId, action, resourceType, resourceId, since, until, limit, offset
   */
  routes.get("/", (c) => {
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
  });

  return routes;
}
