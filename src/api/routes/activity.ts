import { createActivityRoutes } from "@wopr-network/platform-core/api/routes/activity";
import type { AuditEnv } from "@wopr-network/platform-core/audit/types";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { getAuditDb } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";

// Re-export factory from core
export { createActivityRoutes } from "@wopr-network/platform-core/api/routes/activity";

let _dbOverride: DrizzleDb | null = null;

/** Inject a test DB (pass null to reset). */
export function setActivityDb(db: DrizzleDb | null): void {
  _dbOverride = db;
}

function resolveDb(): DrizzleDb {
  return _dbOverride ?? getAuditDb();
}

/** Pre-built activity routes with lazy audit DB. */
export const activityRoutes = new Hono<AuditEnv>();
activityRoutes.route("/", createActivityRoutes(resolveDb));
