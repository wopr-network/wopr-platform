import { authenticateWebSocketUpgrade as _authenticateWs } from "@wopr-network/platform-core/api/routes/ws-auth";
import { getNodeRepo } from "@wopr-network/platform-core/fleet/services";

export type { WsAuthRequest, WsAuthResult } from "@wopr-network/platform-core/api/routes/ws-auth";

/**
 * Authenticate a WebSocket upgrade request for a node agent connection.
 * WOPR-wired: uses lazy getNodeRepo() as the verifier.
 */
export async function authenticateWebSocketUpgrade(req: { nodeId: string; authHeader: string | undefined }) {
  return _authenticateWs(req, getNodeRepo());
}
