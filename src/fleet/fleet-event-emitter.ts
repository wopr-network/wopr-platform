export type FleetEventType = "bot.started" | "bot.stopped" | "bot.created" | "bot.removed" | "bot.restarted";

export interface FleetEvent {
  type: FleetEventType;
  botId: string;
  tenantId: string;
  timestamp: string;
}

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
      } catch {
        // Listener errors must not break emission
      }
    }
  }
}
