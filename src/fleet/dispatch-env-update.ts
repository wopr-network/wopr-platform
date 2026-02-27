import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { botInstances } from "../db/schema/index.js";
import { getCommandBus, getDb } from "./services.js";

/**
 * Dispatch a bot.update command to the node running this bot.
 * Returns { dispatched: true } on success, { dispatched: false, dispatchError } on failure.
 * Never throws — dispatch failure is non-fatal (DB is source of truth).
 */
export async function dispatchEnvUpdate(
  botId: string,
  tenantId: string,
  env: Record<string, string>,
): Promise<{ dispatched: boolean; dispatchError?: string }> {
  try {
    const db = getDb();
    const instance = (await db.select().from(botInstances).where(eq(botInstances.id, botId)))[0];

    if (!instance?.nodeId) {
      return { dispatched: false, dispatchError: "bot_not_deployed" };
    }

    await getCommandBus().send(instance.nodeId, {
      type: "bot.update",
      payload: {
        name: `tenant_${tenantId}`,
        env,
      },
    });

    return { dispatched: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to dispatch bot.update for ${botId}: ${message}`);
    return { dispatched: false, dispatchError: message };
  }
}
