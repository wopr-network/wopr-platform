// src/api/routes/activity.ts
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuditEnv } from "../../audit/types.js";
import type { DrizzleDb } from "../../db/index.js";
import { applyPlatformPragmas, createDb } from "../../db/index.js";
import { auditLog } from "../../db/schema/index.js";

const AUDIT_DB_PATH = process.env.AUDIT_DB_PATH || "/data/platform/audit.db";

let _db: DrizzleDb | null = null;
function getDb(): DrizzleDb {
  if (!_db) {
    const sqlite = new Database(AUDIT_DB_PATH);
    applyPlatformPragmas(sqlite);
    _db = createDb(sqlite);
  }
  return _db;
}

/** Inject a test DB (pass null to reset). */
export function setActivityDb(db: DrizzleDb | null): void {
  _db = db;
}

export const activityRoutes = new Hono<AuditEnv>();

/**
 * GET /api/activity
 *
 * Returns recent activity events for the authenticated user.
 * Query params:
 *   - limit: max results (default 20, max 100)
 */
activityRoutes.get("/", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const limitRaw = c.req.query("limit");
  const limit = Math.min(Math.max(1, limitRaw ? Number.parseInt(limitRaw, 10) : 20), 100);

  const db = getDb();
  const rows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.userId, user.id))
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .all();

  const events = rows.map((row) => ({
    id: row.id,
    timestamp: new Date(row.timestamp * 1000).toISOString(),
    actor: row.userId,
    action: formatAction(row.action),
    target: row.resourceId ?? row.resourceType,
    targetHref: buildTargetHref(row.resourceType, row.resourceId ?? null),
  }));

  return c.json(events);
});

function formatAction(action: string): string {
  const parts = action.split(".");
  if (parts.length === 2) {
    const [resource, verb] = parts;
    const pastTense: Record<string, string> = {
      start: "Started",
      stop: "Stopped",
      create: "Created",
      delete: "Deleted",
      update: "Updated",
      restart: "Restarted",
    };
    return `${pastTense[verb] ?? verb} ${resource}`;
  }
  return action;
}

function buildTargetHref(resourceType: string, resourceId: string | null): string {
  if (!resourceId) return "/dashboard";
  switch (resourceType) {
    case "instance":
    case "bot":
      return `/instances/${resourceId}`;
    case "snapshot":
      return `/instances/${resourceId}`;
    case "key":
      return "/settings";
    default:
      return "/dashboard";
  }
}
