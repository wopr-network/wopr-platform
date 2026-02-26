import type { NodeStatus } from "./node-state-machine.js";
import type { Node, NodeRegistration, NodeTransition, SelfHostedNodeRegistration } from "./repository-types.js";

// Re-export domain types so existing consumers don't break
export type { Node, NodeTransition };
export type { NodeRegistration, SelfHostedNodeRegistration };

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
}
