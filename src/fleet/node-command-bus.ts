import { randomUUID } from "node:crypto";

/** Command to send to a node agent */
export interface Command {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Result from a command execution */
export interface CommandResult {
  id: string;
  type: "command_result";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Minimal interface for socket lookup — satisfied by NodeConnectionRegistry (WOP-868) */
export interface NodeConnectionRegistry {
  getSocket(nodeId: string): { send(data: string): void; readyState: number } | null;
}

/** Internal pending command state */
interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Async command/response bus over WebSocket.
 *
 * Sends commands to node agents via NodeConnectionRegistry and matches
 * responses via a pending Map with configurable timeout.
 * No knowledge of what commands mean — pure transport.
 */
export class NodeCommandBus {
  private readonly registry: NodeConnectionRegistry;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly timeoutMs: number;

  constructor(registry: NodeConnectionRegistry, options?: { timeoutMs?: number }) {
    this.registry = registry;
    this.timeoutMs = options?.timeoutMs ?? 60_000;
  }

  /**
   * Send a command to a node agent and return the result.
   * Rejects if node is not connected or if response times out.
   */
  async send(nodeId: string, command: Omit<Command, "id">): Promise<CommandResult> {
    const ws = this.registry.getSocket(nodeId);
    if (!ws || ws.readyState !== 1) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const id = randomUUID();
    const fullCommand: Command = { id, ...command };

    return new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command ${command.type} timed out on node ${nodeId}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(fullCommand));
    });
  }

  /**
   * Handle an inbound command result from the WebSocket message handler.
   * Resolves the matching pending promise on success, rejects on failure.
   * Silently ignores unknown IDs.
   */
  handleResult(result: CommandResult): void {
    const pending = this.pending.get(result.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(result.id);

    if (!result.success) {
      pending.reject(new Error(result.error ?? "command failed"));
    } else {
      pending.resolve(result);
    }
  }
}
