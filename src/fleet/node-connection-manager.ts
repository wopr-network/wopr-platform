import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { logger } from "../config/logger.js";
import type { BotInstanceRepository } from "../domain/repositories/bot-instance-repository.js";
import type { NodeRepository } from "../domain/repositories/node-repository.js";

/** Node registration request body */
export interface NodeRegistration {
  node_id: string;
  host: string;
  capacity_mb: number;
  agent_version: string;
}

/** Node information returned from listNodes */
export interface NodeInfo {
  id: string;
  host: string;
  status: string;
  capacityMb: number;
  usedMb: number;
  agentVersion: string | null;
  lastHeartbeatAt: number | null;
  registeredAt: number;
}

/** Tenant assignment to a specific node */
export interface TenantAssignment {
  id: string;
  tenantId: string;
  name: string;
  containerName: string;
  estimatedMb: number;
}

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

/** Pending command awaiting result */
interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Platform-side WebSocket manager for node agents.
 *
 * Responsibilities:
 * - Accept WebSocket connections from node agents
 * - Receive heartbeat messages and update nodes table
 * - Send commands to specific node agents and await results
 * - Track connection state per node
 *
 * Uses NodeRepository and BotInstanceRepository for data persistence (async).
 */
export class NodeConnectionManager {
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingCommand>();

  constructor(
    private readonly nodeRepository: NodeRepository,
    private readonly botInstanceRepository: BotInstanceRepository,
  ) {}

  /**
   * Register a new node (called from HTTP POST /internal/nodes/register)
   */
  async registerNode(registration: NodeRegistration): Promise<void> {
    await this.nodeRepository.register({
      nodeId: registration.node_id,
      host: registration.host,
      capacityMb: registration.capacity_mb,
      agentVersion: registration.agent_version,
    });

    logger.info(`Node ${registration.node_id} registered`);
  }

  /**
   * Accept an incoming WebSocket for a node
   */
  handleWebSocket(nodeId: string, ws: WebSocket): void {
    // Close any existing connection for this node
    const existing = this.connections.get(nodeId);
    if (existing && existing.readyState === 1 /* OPEN */) {
      logger.warn(`Closing existing WebSocket for ${nodeId}`);
      existing.close();
    }

    this.connections.set(nodeId, ws);
    logger.info(`WebSocket connected for node ${nodeId}`);

    ws.on("message", (data: Buffer) => {
      this.handleMessage(nodeId, data);
    });

    ws.on("close", () => {
      logger.info(`WebSocket closed for ${nodeId}`);
      // Only remove if this is still the current connection (avoids race with reconnects)
      if (this.connections.get(nodeId) === ws) {
        this.connections.delete(nodeId);
      }
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error for ${nodeId}`, { err: err.message });
    });
  }

  /**
   * Handle an inbound WebSocket message from a node
   */
  private handleMessage(nodeId: string, data: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      logger.warn(`Received non-JSON message from ${nodeId}`);
      return;
    }

    const msg = parsed as Record<string, unknown>;

    // Handle heartbeat
    if (msg.type === "heartbeat") {
      this.processHeartbeat(nodeId, msg);
      return;
    }

    // Handle command result
    if (msg.type === "command_result" && typeof msg.id === "string") {
      const result = msg as unknown as CommandResult;
      const pending = this.pending.get(result.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(result.id);
        if (result.success) {
          pending.resolve(result);
        } else {
          pending.reject(new Error(result.error ?? "Command failed"));
        }
      }
      return;
    }

    // Handle health events (optional logging)
    if (msg.type === "health_event") {
      logger.warn(`Health event from ${nodeId}`, { event: msg });
      return;
    }

    logger.debug(`Unknown message type from ${nodeId}`, { msg });
  }

  /**
   * Process a heartbeat message and update nodes table
   */
  private async processHeartbeat(nodeId: string, msg: Record<string, unknown>): Promise<void> {
    const containers = msg.containers as Array<{ name: string; memory_mb: number }> | undefined;
    const usedMb = containers?.reduce((sum, c) => sum + (c.memory_mb ?? 0), 0) ?? 0;
    const agentVersion = (msg.agent_version as string | undefined) ?? "unknown";

    try {
      await this.nodeRepository.updateHeartbeat(nodeId, agentVersion, usedMb);
      logger.debug(`Heartbeat received from ${nodeId}`, { usedMb });
    } catch (error) {
      logger.warn(`Failed to process heartbeat from ${nodeId}`, { error });
    }
  }

  /**
   * Send a command to a node agent and return the result
   */
  async sendCommand(nodeId: string, command: Omit<Command, "id">, timeoutMs = 60_000): Promise<CommandResult> {
    const ws = this.connections.get(nodeId);
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const id = randomUUID();
    const fullCommand: Command = { id, ...command };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command ${command.type} timed out on node ${nodeId}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(fullCommand));

      logger.debug(`Sent command ${command.type} to ${nodeId}`, { commandId: id });
    });
  }

  /**
   * Get current status of all nodes
   */
  async listNodes(): Promise<NodeInfo[]> {
    const nodes = await this.nodeRepository.list();
    return nodes.map(this.nodeToNodeInfo);
  }

  /**
   * Get tenants assigned to a specific node
   */
  async getNodeTenants(nodeId: string): Promise<TenantAssignment[]> {
    const bots = await this.botInstanceRepository.listByNode(nodeId);
    return bots.map((bot) => ({
      id: bot.id,
      tenantId: bot.tenantId.toString(),
      name: bot.name,
      containerName: `tenant_${bot.tenantId}`,
      estimatedMb: 100,
    }));
  }

  /**
   * Find the best target node for recovery (most free capacity)
   */
  async findBestTarget(excludeNodeId: string, requiredMb: number): Promise<NodeInfo | null> {
    const node = await this.nodeRepository.findBestForRecovery(excludeNodeId, requiredMb);
    return node ? this.nodeToNodeInfo(node) : null;
  }

  /**
   * Reassign a bot to a new node
   */
  async reassignTenant(botId: string, targetNodeId: string): Promise<void> {
    await this.botInstanceRepository.assignToNode(botId, targetNodeId);
    logger.info(`Reassigned bot ${botId} to node ${targetNodeId}`);
  }

  /**
   * Update a node's used capacity
   */
  async addNodeCapacity(nodeId: string, deltaMb: number): Promise<void> {
    const node = await this.nodeRepository.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    await this.nodeRepository.updateCapacity(nodeId, node.usedMb + deltaMb);
  }

  private nodeToNodeInfo(node: {
    id: string;
    host: string;
    status: string;
    capacityMb: number;
    usedMb: number;
    agentVersion: string | null;
    lastHeartbeatAt: Date | null;
    registeredAt: Date;
  }): NodeInfo {
    return {
      id: node.id,
      host: node.host,
      status: node.status,
      capacityMb: node.capacityMb,
      usedMb: node.usedMb,
      agentVersion: node.agentVersion,
      lastHeartbeatAt: node.lastHeartbeatAt ? node.lastHeartbeatAt.getTime() / 1000 : null,
      registeredAt: node.registeredAt.getTime() / 1000,
    };
  }
}
