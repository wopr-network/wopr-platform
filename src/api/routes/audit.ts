import {
  createAdminAuditRoutes as _createAdminAudit,
  createAuditRoutes as _createAudit,
} from "@wopr-network/platform-core/api/routes/audit";
import type { AuditEnv } from "@wopr-network/platform-core/audit/types";
import { getDb } from "@wopr-network/platform-core/fleet/services";
import type { Hono } from "hono";

// Re-export factories from core — other brands use these directly
export { createAdminAuditRoutes, createAuditRoutes } from "@wopr-network/platform-core/api/routes/audit";

// Pre-built routes with lazy DB init (avoids calling getDb() at module load time).
export const auditRoutes: Hono<AuditEnv> = _createAudit(getDb);
export const adminAuditRoutes: Hono<AuditEnv> = _createAdminAudit(getDb);
