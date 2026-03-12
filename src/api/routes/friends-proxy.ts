import { proxyToInstance as _proxyToInstance } from "@wopr-network/platform-core/api/routes/friends-proxy";
import { logger } from "@wopr-network/platform-core/config/logger";

export type { ProxyResult } from "@wopr-network/platform-core/api/routes/friends-proxy";

/**
 * Proxy a request to a bot instance's internal friend management API.
 * Backward-compatible wrapper that injects the platform logger.
 */
export async function proxyToInstance(instanceId: string, method: string, path: string, body?: unknown) {
  return _proxyToInstance(instanceId, method, path, body, { logger });
}
