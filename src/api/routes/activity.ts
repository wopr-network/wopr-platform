// src/api/routes/activity.ts
import { Hono } from "hono";
import { queryAuditLog } from "../../audit/query.js";
import type { AuditEnv } from "../../audit/types.js";
import type { DrizzleDb } from "../../db/index.js";
import { getAuditDb } from "../../fleet/services.js";

let _dbOverride: DrizzleDb | null = null;

/** Inject a test DB (pass null to reset). */
export function setActivityDb(db: DrizzleDb | null): void {
  _dbOverride = db;
}

function resolveDb(): DrizzleDb {
  return _dbOverride ?? getAuditDb();
}

// BOUNDARY(WOP-805): This REST route is a tRPC migration candidate.
// The UI calls GET /api/activity via session cookie. Should become
// a tRPC procedure (e.g., activity.feed) for type safety.
// Blocker: none — straightforward migration.
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

  const db = resolveDb();
  const rows = queryAuditLog(db, { userId: user.id, limit });

  const events = rows.map((row) => ({
    id: row.id,
    timestamp: new Date(row.timestamp).toISOString(),
    actor: row.user_id,
    action: formatAction(row.action),
    target: row.resource_id ?? row.resource_type,
    targetHref: buildTargetHref(row.resource_type, row.resource_id ?? null),
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
