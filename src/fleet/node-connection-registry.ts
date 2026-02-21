import type { WebSocket } from "ws";

/**
 * Pure socket tracking registry — no heartbeats, no commands, no DB.
 * Tracks live WebSocket connections keyed by node ID.
 */
export class NodeConnectionRegistry {
  private readonly connections = new Map<string, WebSocket>();

  /** Store a WebSocket for a node, closing any existing one first. */
  accept(nodeId: string, ws: WebSocket): void {
    const existing = this.connections.get(nodeId);
    if (existing) {
      existing.close();
    }
    this.connections.set(nodeId, ws);
  }

  /** Close and remove the connection for a node. No-op if unknown. */
  close(nodeId: string): void {
    const ws = this.connections.get(nodeId);
    if (ws) {
      ws.close();
      this.connections.delete(nodeId);
    }
  }

  /** Get the WebSocket for a node, or null if not tracked. */
  getSocket(nodeId: string): WebSocket | null {
    return this.connections.get(nodeId) ?? null;
  }

  /** Check if a node has an OPEN WebSocket connection. */
  isConnected(nodeId: string): boolean {
    const ws = this.connections.get(nodeId);
    return ws != null && ws.readyState === 1;
  }

  /** Return node IDs that have OPEN (readyState === 1) connections. */
  listConnected(): string[] {
    const result: string[] = [];
    for (const [nodeId, ws] of this.connections) {
      if (ws.readyState === 1) {
        result.push(nodeId);
      }
    }
    return result;
  }
}
