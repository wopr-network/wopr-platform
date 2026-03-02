import { logger } from "../config/logger.js";

/**
 * Dispatch a plugin config update to the running WOPR daemon via direct HTTP.
 * Returns { dispatched: true } on success, { dispatched: false, dispatchError } on failure.
 * Never throws — dispatch failure is non-fatal (config will be applied on next restart).
 */
export async function dispatchPluginConfig(
  botId: string,
  pluginId: string,
  config: Record<string, unknown>,
): Promise<{ dispatched: boolean; dispatchError?: string }> {
  try {
    const url = `http://wopr-${botId}:3000/plugins/${pluginId}/config`;
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { dispatched: true };
    }

    const errorText = await response.text().catch(() => "Unknown error");
    const msg = `daemon returned ${response.status}: ${errorText}`;
    logger.warn(`Failed to dispatch plugin config for ${botId}/${pluginId}: ${msg}`);
    return { dispatched: false, dispatchError: msg };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to dispatch plugin config for ${botId}/${pluginId}: ${message}`);
    return { dispatched: false, dispatchError: message };
  }
}
