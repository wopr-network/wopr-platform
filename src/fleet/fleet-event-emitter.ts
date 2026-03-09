import { logger } from "../config/logger.js";

export type BotEventType = "bot.started" | "bot.stopped" | "bot.created" | "bot.removed" | "bot.restarted";

export type NodeEventType =
  | "node.provisioned"
  | "node.registered"
  | "node.draining"
  | "node.drained"
  | "node.deprovisioned"
  | "node.heartbeat_lost"
  | "node.returned";

export type FleetEventType = BotEventType | NodeEventType;

export interface BotFleetEvent {
  type: BotEventType;
  botId: string;
  tenantId: string;
  timestamp: string;
}

export interface NodeFleetEvent {
  type: NodeEventType;
  nodeId: string;
  timestamp: string;
}

export type FleetEvent = BotFleetEvent | NodeFleetEvent;

export type FleetEventListener = (event: FleetEvent) => void;

export class FleetEventEmitter {
  private listeners = new Set<FleetEventListener>();

  subscribe(listener: FleetEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: FleetEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error("FleetEventEmitter listener error", { err });
        // Listener errors must not break emission
      }
    }
  }
}
