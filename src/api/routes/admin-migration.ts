import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { getAdminAuditLog, getMigrationOrchestrator } from "../../fleet/services.js";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

const migrateInputSchema = z.object({
  targetNodeId: z.string().min(1).optional(),
});

export const adminMigrationRoutes = new Hono<AuthEnv>();

/**
 * POST /api/admin/migrate/:botId
 * Migrate a specific bot to a target node (or auto-select).
 */
adminMigrationRoutes.post("/:botId", adminAuth, async (c) => {
  const botId = c.req.param("botId") as string;

  let body: z.infer<typeof migrateInputSchema> = {};
  try {
    body = migrateInputSchema.parse(await c.req.json());
  } catch {
    // No body is fine — auto-select target
  }

  try {
    const result = await getMigrationOrchestrator().migrate(botId, body.targetNodeId);

    try {
      getAdminAuditLog().log({
        adminUser: (c.get("user") as { id?: string } | undefined)?.id ?? "unknown",
        action: "bot.migrate",
        category: "config",
        details: { botId, targetNodeId: body.targetNodeId, success: result.success },
        outcome: result.success ? "success" : "failure",
      });
    } catch {
      /* audit must not break request */
    }

    if (result.success) {
      return c.json({ success: true, result });
    }
    return c.json({ success: false, result }, 400);
  } catch (err) {
    logger.error("Migration failed", { botId, err });
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
