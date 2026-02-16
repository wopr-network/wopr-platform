/**
 * Repository Interface: NodeRepository (ASYNC)
 *
 * Manages compute nodes in the platform. Each node runs the wopr-node-agent
 * daemon that sends heartbeats and executes commands.
 */
import type { Node, NodeStatus } from "../entities/node.js";

export interface NodeRegistration {
  nodeId: string;
  host: string;
  capacityMb: number;
  agentVersion: string;
}

export interface NodeRepository {
  /**
   * Get a node by ID. Returns null if not found.
   */
  get(nodeId: string): Promise<Node | null>;

  /**
   * Register a new node or update existing node registration.
   */
  register(registration: NodeRegistration): Promise<Node>;

  /**
   * List all nodes.
   */
  list(): Promise<Node[]>;

  /**
   * List nodes by status.
   */
  listByStatus(status: NodeStatus): Promise<Node[]>;

  /**
   * List only active nodes.
   */
  listActive(): Promise<Node[]>;

  /**
   * Update a node's heartbeat (marks node as active).
   */
  updateHeartbeat(nodeId: string, agentVersion: string, usedMb: number): Promise<void>;

  /**
   * Update a node's used capacity.
   */
  updateCapacity(nodeId: string, usedMb: number): Promise<void>;

  /**
   * Update node status.
   */
  updateStatus(nodeId: string, status: NodeStatus): Promise<void>;

  /**
   * Find the best target node for recovery (most free capacity).
   */
  findBestForRecovery(excludeNodeId: string, requiredMb: number): Promise<Node | null>;

  /**
   * Delete a node.
   */
  delete(nodeId: string): Promise<void>;
}
