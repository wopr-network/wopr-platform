import { logger } from "../config/logger.js";

/**
 * Dispatch a plugin install command to the running WOPR daemon via direct HTTP.
 * Returns { dispatched: true } on success, { dispatched: false, dispatchError } on failure.
 * Never throws — dispatch failure is non-fatal (plugin will be installed on next restart).
 */
export async function dispatchPluginInstall(
  botId: string,
  npmPackage: string,
): Promise<{ dispatched: boolean; dispatchError?: string }> {
  try {
    const url = `http://wopr-${botId}:3000/plugins/install`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: npmPackage }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) {
      return { dispatched: true };
    }

    const errorText = await response.text().catch(() => "Unknown error");
    const msg = `daemon returned ${response.status}: ${errorText}`;
    logger.warn(`Failed to dispatch plugin install for ${botId}: ${msg}`);
    return { dispatched: false, dispatchError: msg };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to dispatch plugin install for ${botId}: ${message}`);
    return { dispatched: false, dispatchError: message };
  }
}
