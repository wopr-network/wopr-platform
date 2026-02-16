/**
 * In-Memory Implementation: NodeRepository (ASYNC)
 */

import { Node, type NodeStatus } from "../../domain/entities/node.js";
import type { NodeRepository } from "../../domain/repositories/node-repository.js";

interface StoredNode {
  id: string;
  host: string;
  status: NodeStatus;
  capacityMb: number;
  usedMb: number;
  agentVersion: string | null;
  lastHeartbeatAt: number | null;
  registeredAt: number;
  updatedAt: number;
}

export class InMemoryNodeRepository implements NodeRepository {
  private nodes = new Map<string, StoredNode>();

  async get(nodeId: string): Promise<Node | null> {
    const node = this.nodes.get(nodeId);
    return node ? this.toNode(node) : null;
  }

  async register(registration: {
    nodeId: string;
    host: string;
    capacityMb: number;
    agentVersion: string;
  }): Promise<Node> {
    const now = Date.now();
    const existing = this.nodes.get(registration.nodeId);

    if (existing) {
      const updated: StoredNode = {
        ...existing,
        host: registration.host,
        capacityMb: registration.capacityMb,
        agentVersion: registration.agentVersion,
        status: "active",
        lastHeartbeatAt: now,
        updatedAt: now,
      };
      this.nodes.set(registration.nodeId, updated);
      return this.toNode(updated);
    }

    const newNode: StoredNode = {
      id: registration.nodeId,
      host: registration.host,
      status: "active",
      capacityMb: registration.capacityMb,
      usedMb: 0,
      agentVersion: registration.agentVersion,
      lastHeartbeatAt: null,
      registeredAt: now,
      updatedAt: now,
    };
    this.nodes.set(registration.nodeId, newNode);
    return this.toNode(newNode);
  }

  async list(): Promise<Node[]> {
    return Array.from(this.nodes.values()).map(this.toNode);
  }

  async listByStatus(status: NodeStatus): Promise<Node[]> {
    return Array.from(this.nodes.values())
      .filter((n) => n.status === status)
      .map(this.toNode);
  }

  async listActive(): Promise<Node[]> {
    return this.listByStatus("active");
  }

  async updateHeartbeat(nodeId: string, agentVersion: string, usedMb: number): Promise<void> {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      throw new Error(`Node ${nodeId} not found`);
    }

    const now = Date.now();
    this.nodes.set(nodeId, {
      ...existing,
      agentVersion,
      usedMb,
      status: "active",
      lastHeartbeatAt: now,
      updatedAt: now,
    });
  }

  async updateCapacity(nodeId: string, usedMb: number): Promise<void> {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      throw new Error(`Node ${nodeId} not found`);
    }

    this.nodes.set(nodeId, {
      ...existing,
      usedMb,
      updatedAt: Date.now(),
    });
  }

  async updateStatus(nodeId: string, status: NodeStatus): Promise<void> {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      throw new Error(`Node ${nodeId} not found`);
    }

    this.nodes.set(nodeId, {
      ...existing,
      status,
      updatedAt: Date.now(),
    });
  }

  async findBestForRecovery(excludeNodeId: string, requiredMb: number): Promise<Node | null> {
    const candidates = Array.from(this.nodes.values())
      .filter((n) => n.id !== excludeNodeId && n.status === "active")
      .filter((n) => n.capacityMb - n.usedMb >= requiredMb)
      .sort((a, b) => b.capacityMb - b.usedMb - (a.capacityMb - a.usedMb));

    return candidates.length > 0 ? this.toNode(candidates[0]) : null;
  }

  async delete(nodeId: string): Promise<void> {
    this.nodes.delete(nodeId);
  }

  private toNode(stored: StoredNode): Node {
    return Node.fromRow({
      id: stored.id,
      host: stored.host,
      status: stored.status,
      capacityMb: stored.capacityMb,
      usedMb: stored.usedMb,
      agentVersion: stored.agentVersion,
      lastHeartbeatAt: stored.lastHeartbeatAt,
      registeredAt: stored.registeredAt,
      updatedAt: stored.updatedAt,
    });
  }
}
