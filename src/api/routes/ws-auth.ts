import { getNodeRepo } from "../../fleet/services.js";

export interface WsAuthRequest {
  nodeId: string;
  authHeader: string | undefined;
}

export interface WsAuthResult {
  authenticated: boolean;
  nodeId?: string;
  reason?: string;
}

/**
 * Authenticate a WebSocket upgrade request for a node agent connection.
 *
 * The bearer token resolves to a specific node via per-node persistent secret;
 * the resolved nodeId must match the URL nodeId.
 */
export async function authenticateWebSocketUpgrade(req: WsAuthRequest): Promise<WsAuthResult> {
  const { nodeId, authHeader } = req;
  const bearer = authHeader?.replace(/^Bearer\s+/i, "");

  // Per-node persistent secret
  if (bearer) {
    const nodeBySecret = await getNodeRepo().getBySecret(bearer);
    if (nodeBySecret && nodeBySecret.id === nodeId) {
      return { authenticated: true, nodeId };
    }
  }

  // No valid auth
  if (!bearer) {
    return { authenticated: false, reason: "unauthorized" };
  }
  return { authenticated: false, reason: "unauthorized" };
}
