import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { getMigrationManager } from "../../fleet/services.js";

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
  const botId = c.req.param("botId");

  let body: z.infer<typeof migrateInputSchema> = {};
  try {
    body = migrateInputSchema.parse(await c.req.json());
  } catch {
    // No body is fine — auto-select target
  }

  try {
    const migrationManager = getMigrationManager();
    const result = await migrationManager.migrateTenant(botId, body.targetNodeId);

    if (result.success) {
      return c.json({ success: true, result });
    }
    return c.json({ success: false, result }, 400);
  } catch (err) {
    logger.error("Migration failed", { botId, err });
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

