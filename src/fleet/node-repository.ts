import type { NodeStatus } from "./node-state-machine.js";
import type { Node, NodeRegistration, NodeTransition, SelfHostedNodeRegistration } from "./repository-types.js";

// Re-export domain types so existing consumers don't break
export type { Node, NodeTransition };
export type { NodeRegistration, SelfHostedNodeRegistration };

export interface INodeRepository {
  getById(id: string): Node | null;
  getBySecret(secret: string): Node | null;
  list(statuses?: NodeStatus[]): Node[];
  register(data: NodeRegistration): Node;
  registerSelfHosted(data: SelfHostedNodeRegistration): Node;
  transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Node;
  updateHeartbeat(id: string, usedMb: number): void;
  addCapacity(id: string, deltaMb: number): void;
  findBestTarget(excludeId: string, requiredMb: number): Node | null;
  listTransitions(nodeId: string, limit?: number): NodeTransition[];
  delete(id: string): void;
}
