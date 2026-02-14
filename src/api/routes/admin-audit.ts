import type Database from "better-sqlite3";
import { Hono } from "hono";
import { AdminAuditLog } from "../../admin/audit-log.js";
import { initAdminAuditSchema } from "../../admin/audit-schema.js";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

export interface AdminAuditRouteDeps {
  db: Database.Database;
}

let _auditLog: AdminAuditLog | null = null;

/** Set dependencies for admin audit routes. */
export function setAdminAuditDeps(deps: AdminAuditRouteDeps): void {
  initAdminAuditSchema(deps.db);
  _auditLog = new AdminAuditLog(deps.db);
}

function getAuditLog(): AdminAuditLog {
  if (!_auditLog) {
    throw new Error("Admin audit routes not initialized -- call setAdminAuditDeps() first");
  }
  return _auditLog;
}

function parseIntParam(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Create admin audit API routes with an explicit database.
 * Used in tests to inject an in-memory database.
 */
export function createAdminAuditApiRoutes(db: Database.Database): Hono<AuthEnv> {
  const auditLog = new AdminAuditLog(db);
  const routes = new Hono<AuthEnv>();

  routes.get("/", (c) => {
    const filters = {
      admin: c.req.query("admin") ?? undefined,
      action: c.req.query("action") ?? undefined,
      category: c.req.query("category") ?? undefined,
      tenant: c.req.query("tenant") ?? undefined,
      from: parseIntParam(c.req.query("from")),
      to: parseIntParam(c.req.query("to")),
      limit: parseIntParam(c.req.query("limit")),
      offset: parseIntParam(c.req.query("offset")),
    };

    try {
      const result = auditLog.query(filters);
      return c.json(result);
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  routes.get("/export", (c) => {
    const filters = {
      admin: c.req.query("admin") ?? undefined,
      action: c.req.query("action") ?? undefined,
      category: c.req.query("category") ?? undefined,
      tenant: c.req.query("tenant") ?? undefined,
      from: parseIntParam(c.req.query("from")),
      to: parseIntParam(c.req.query("to")),
    };

    try {
      const csv = auditLog.exportCsv(filters);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="audit-log.csv"',
        },
      });
    } catch {
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return routes;
}

/** Pre-built admin audit routes with auth and lazy initialization. */
export const adminAuditApiRoutes = new Hono<AuthEnv>();

adminAuditApiRoutes.use("*", adminAuth);

adminAuditApiRoutes.get("/", (c) => {
  const auditLog = getAuditLog();
  const filters = {
    admin: c.req.query("admin") ?? undefined,
    action: c.req.query("action") ?? undefined,
    category: c.req.query("category") ?? undefined,
    tenant: c.req.query("tenant") ?? undefined,
    from: parseIntParam(c.req.query("from")),
    to: parseIntParam(c.req.query("to")),
    limit: parseIntParam(c.req.query("limit")),
    offset: parseIntParam(c.req.query("offset")),
  };

  try {
    const result = auditLog.query(filters);
    return c.json(result);
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

adminAuditApiRoutes.get("/export", (c) => {
  const auditLog = getAuditLog();
  const filters = {
    admin: c.req.query("admin") ?? undefined,
    action: c.req.query("action") ?? undefined,
    category: c.req.query("category") ?? undefined,
    tenant: c.req.query("tenant") ?? undefined,
    from: parseIntParam(c.req.query("from")),
    to: parseIntParam(c.req.query("to")),
  };

  try {
    const csv = auditLog.exportCsv(filters);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="audit-log.csv"',
      },
    });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});
