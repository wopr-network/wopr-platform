import type { NodeStatus } from "./node-state-machine.js";
import type {
  NewProvisioningNode,
  Node,
  NodeRegistration,
  NodeTransition,
  ProvisionDataUpdate,
  SelfHostedNodeRegistration,
} from "./repository-types.js";

// Re-export domain types so existing consumers don't break
export type { Node, NodeTransition };
export type { NodeRegistration, SelfHostedNodeRegistration };
export type { NewProvisioningNode, ProvisionDataUpdate };

export interface INodeRepository {
  getById(id: string): Promise<Node | null>;
  getBySecret(secret: string): Promise<Node | null>;
  list(statuses?: NodeStatus[]): Promise<Node[]>;
  register(data: NodeRegistration): Promise<Node>;
  registerSelfHosted(data: SelfHostedNodeRegistration): Promise<Node>;
  transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Promise<Node>;
  updateHeartbeat(id: string, usedMb: number): Promise<void>;
  addCapacity(id: string, deltaMb: number): Promise<void>;
  findBestTarget(excludeId: string, requiredMb: number): Promise<Node | null>;
  listTransitions(nodeId: string, limit?: number): Promise<NodeTransition[]>;
  delete(id: string): Promise<void>;
  /** Verify a per-node secret against stored hash. Returns true/false, or null if node not found or has no secret. */
  verifyNodeSecret(nodeId: string, secret: string): Promise<boolean | null>;
  /** Insert a node in provisioning state (placeholder before DO droplet is created). */
  insertProvisioning(data: NewProvisioningNode): Promise<Node>;
  /** Update a provisioning node with real droplet data (IP, droplet ID, capacity, cost). */
  updateProvisionData(id: string, data: ProvisionDataUpdate): Promise<void>;
  /** Update a node's provisionStage field. */
  updateProvisionStage(id: string, stage: string): Promise<void>;
  /** Mark a node as failed with an error message. */
  markFailed(id: string, error: string): Promise<void>;
  /** Get just the status of a node (lightweight heartbeat check). Returns null if not found. */
  getStatus(id: string): Promise<NodeStatus | null>;
  /** Update heartbeat timestamp and usedMb, optionally setting status. */
  updateHeartbeatWithStatus(id: string, usedMb: number, status?: NodeStatus): Promise<void>;
}
