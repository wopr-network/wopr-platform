import type { FleetEventEmitter } from "./fleet-event-emitter.js";
import type {
  Node as DrizzleNode,
  NodeRegistration,
  RecoveryEvent,
  RecoveryItem,
  SelfHostedNodeRegistration,
} from "./repository-types.js";

/** Subset of INodeRepository used by NodeRegistrar. */
export interface NodeRegistrarNodeRepo {
  register(data: NodeRegistration): Promise<DrizzleNode>;
  registerSelfHosted(data: SelfHostedNodeRegistration): Promise<DrizzleNode>;
}

export type { SelfHostedNodeRegistration };

/** Subset of IRecoveryRepository used by NodeRegistrar. */
export interface NodeRegistrarRecoveryRepo {
  listOpenEvents(): Promise<RecoveryEvent[]>;
  getWaitingItems(eventId: string): Promise<RecoveryItem[]>;
}

export interface NodeRegistrarOptions {
  onReturning?: (nodeId: string) => void;
  onRetryWaiting?: (eventId: string) => void;
}

export class NodeRegistrar {
  private readonly nodeRepo: NodeRegistrarNodeRepo;
  private readonly recoveryRepo: NodeRegistrarRecoveryRepo;
  private readonly onReturning?: (nodeId: string) => void;
  private readonly onRetryWaiting?: (eventId: string) => void;
  private readonly eventEmitter?: FleetEventEmitter;

  constructor(
    nodeRepo: NodeRegistrarNodeRepo,
    recoveryRepo: NodeRegistrarRecoveryRepo,
    options?: NodeRegistrarOptions,
    eventEmitter?: FleetEventEmitter,
  ) {
    this.nodeRepo = nodeRepo;
    this.recoveryRepo = recoveryRepo;
    this.onReturning = options?.onReturning;
    this.onRetryWaiting = options?.onRetryWaiting;
    this.eventEmitter = eventEmitter;
  }

  async register(data: NodeRegistration): Promise<DrizzleNode> {
    const node = await this.nodeRepo.register(data);

    if (node.status === "returning") {
      this.eventEmitter?.emit({ type: "node.returned", nodeId: node.id, timestamp: new Date().toISOString() });
      if (this.onReturning) {
        this.onReturning(node.id);
      }
    } else {
      this.eventEmitter?.emit({ type: "node.registered", nodeId: node.id, timestamp: new Date().toISOString() });
    }

    if (this.onRetryWaiting) {
      const openEvents = await this.recoveryRepo.listOpenEvents();
      for (const event of openEvents) {
        const waiting = await this.recoveryRepo.getWaitingItems(event.id);
        if (waiting.length > 0) {
          this.onRetryWaiting(event.id);
        }
      }
    }

    return node;
  }

  async registerSelfHosted(data: SelfHostedNodeRegistration): Promise<DrizzleNode> {
    const node = await this.nodeRepo.registerSelfHosted(data);

    this.eventEmitter?.emit({ type: "node.registered", nodeId: node.id, timestamp: new Date().toISOString() });

    if (this.onRetryWaiting) {
      const openEvents = await this.recoveryRepo.listOpenEvents();
      for (const event of openEvents) {
        const waiting = await this.recoveryRepo.getWaitingItems(event.id);
        if (waiting.length > 0) {
          this.onRetryWaiting(event.id);
        }
      }
    }

    return node;
  }
}
