import { getNodeRepo } from "../../fleet/services.js";
import { validateNodeAuth } from "./internal-nodes.js";

export interface WsAuthRequest {
  nodeId: string;
  authHeader: string | undefined;
  nodeSecretHeader: string | undefined;
}

export interface WsAuthResult {
  authenticated: boolean;
  nodeId?: string;
  reason?: string;
}

/**
 * Authenticate a WebSocket upgrade request for a node agent connection.
 *
 * Path 1 (static NODE_SECRET): Requires BOTH the shared secret AND a valid
 * per-node X-Node-Secret header. Legacy nodes without a stored per-node
 * secret are rejected — they must re-register (WOP-1353).
 *
 * Path 2 (per-node persistent secret): The bearer token resolves to a specific
 * node; the resolved nodeId must match the URL nodeId.
 */
export async function authenticateWebSocketUpgrade(req: WsAuthRequest): Promise<WsAuthResult> {
  const { nodeId, authHeader, nodeSecretHeader } = req;
  const bearer = authHeader?.replace(/^Bearer\s+/i, "");

  // Path 1: Static NODE_SECRET
  const staticAuthResult = validateNodeAuth(authHeader);
  if (staticAuthResult === true) {
    const verified = await getNodeRepo().verifyNodeSecret(nodeId, nodeSecretHeader ?? "");
    if (verified === true) {
      return { authenticated: true, nodeId };
    }
    if (verified === false) {
      return { authenticated: false, reason: "invalid per-node secret" };
    }
    // verified === null → node not found or has no stored secret (legacy)
    return { authenticated: false, reason: "per-node secret required — re-register node" };
  }

  // Path 2: Per-node persistent secret
  if (bearer) {
    const nodeBySecret = await getNodeRepo().getBySecret(bearer);
    if (nodeBySecret && nodeBySecret.id === nodeId) {
      return { authenticated: true, nodeId };
    }
  }

  // No valid auth
  if (staticAuthResult === null && !bearer) {
    return { authenticated: false, reason: "no auth configured" };
  }
  return { authenticated: false, reason: "unauthorized" };
}
