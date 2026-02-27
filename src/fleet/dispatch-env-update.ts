import { logger } from "../config/logger.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import { getCommandBus } from "./services.js";

/**
 * Dispatch a bot.update command to the node running this bot.
 * Returns { dispatched: true } on success, { dispatched: false, dispatchError } on failure.
 * Never throws — dispatch failure is non-fatal (DB is source of truth).
 */
export async function dispatchEnvUpdate(
  botId: string,
  tenantId: string,
  env: Record<string, string>,
  botInstanceRepo: IBotInstanceRepository,
): Promise<{ dispatched: boolean; dispatchError?: string }> {
  try {
    const instance = await botInstanceRepo.getById(botId);

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
