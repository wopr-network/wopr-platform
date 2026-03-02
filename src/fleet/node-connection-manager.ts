import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { logger } from "../config/logger.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { INodeRepository } from "./node-repository.js";
import type { OrphanCleaner } from "./orphan-cleaner.js";
import type { IRecoveryRepository } from "./recovery-repository.js";
import type { Node } from "./repository-types.js";

// Re-export Node as NodeInfo for backwards compatibility with capacity-alerts.ts
export type { Node as NodeInfo };

/** Node registration request body */
export interface NodeRegistration {
  node_id: string;
  host: string;
  capacity_mb: number;
  agent_version: string;
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
 */
/** Statuses that indicate a node has crashed and been recovered by RecoveryManager */
const CRASHED_STATUSES = new Set(["offline", "recovering", "failed"]);

export class NodeConnectionManager {
  private readonly nodeRepo: INodeRepository;
  private readonly botInstanceRepo: IBotInstanceRepository;
  private readonly recoveryRepo: IRecoveryRepository;
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingCommand>();
  private orphanCleaner?: OrphanCleaner;
  private readonly cleanupInFlight = new Set<string>();
  private readonly onNodeRegistered?: () => void;

  constructor(
    nodeRepo: INodeRepository,
    botInstanceRepo: IBotInstanceRepository,
    recoveryRepo: IRecoveryRepository,
    options?: { onNodeRegistered?: () => void },
  ) {
    this.nodeRepo = nodeRepo;
    this.botInstanceRepo = botInstanceRepo;
    this.recoveryRepo = recoveryRepo;
    this.onNodeRegistered = options?.onNodeRegistered;
  }

  /** Inject OrphanCleaner after construction to break the circular dependency. */
  setOrphanCleaner(cleaner: OrphanCleaner): void {
    this.orphanCleaner = cleaner;
  }

  /**
   * Register a new node (called from HTTP POST /internal/nodes/register)
   */
  async registerNode(registration: NodeRegistration): Promise<void> {
    const existing = await this.nodeRepo.getById(registration.node_id);

    if (existing) {
      const wasInCrashedState = CRASHED_STATUSES.has(existing.status);

      // Re-register via repo (handles metadata update + state transition)
      await this.nodeRepo.register({
        nodeId: registration.node_id,
        host: registration.host,
        capacityMb: registration.capacity_mb,
        agentVersion: registration.agent_version,
      });

      // If node was in a dead state, close any in-flight recovery events
      if (wasInCrashedState) {
        await this.recoveryRepo.completeInProgressEvents(registration.node_id);
        logger.info(`Node ${registration.node_id} re-registered as returning (prior: ${existing.status})`);
      } else {
        logger.info(`Node ${registration.node_id} re-registered`);
      }
    } else {
      await this.nodeRepo.register({
        nodeId: registration.node_id,
        host: registration.host,
        capacityMb: registration.capacity_mb,
        agentVersion: registration.agent_version,
      });
      logger.info(`Node ${registration.node_id} registered`);
    }

    // Trigger auto-retry check for waiting recovery tenants
    if (this.onNodeRegistered) {
      this.onNodeRegistered();
    }
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
      logger.info(`WebSocket closed for node ${nodeId}`);
      // Only remove if this is still the current connection (avoids race with reconnects)
      if (this.connections.get(nodeId) === ws) {
        this.connections.delete(nodeId);
      }
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error for node ${nodeId}`, { err: err.message });
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
      this.processHeartbeat(nodeId, msg).catch((err) => {
        logger.error(`Heartbeat processing failed for ${nodeId}`, { err });
      });
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
   * Process a heartbeat message and update nodes table.
   * For "returning" nodes, triggers OrphanCleaner (fire-and-forget) instead of
   * immediately setting active — cleanup handles the transition.
   */
  private async processHeartbeat(nodeId: string, msg: Record<string, unknown>): Promise<void> {
    const containers = msg.containers as Array<{ name: string; memory_mb: number }> | undefined;
    const usedMb = containers?.reduce((sum, c) => sum + (c.memory_mb ?? 0), 0) ?? 0;

    // Check current node status to decide how to handle the heartbeat
    const status = await this.nodeRepo.getStatus(nodeId);

    if (status === null) {
      logger.warn(`Heartbeat from unknown node ${nodeId}`);
      return;
    }

    // For returning nodes: trigger orphan cleanup (it will transition to active).
    // Use cleanupInFlight set to prevent double-invocation if two heartbeats race.
    if (status === "returning" && this.orphanCleaner && !this.cleanupInFlight.has(nodeId)) {
      this.cleanupInFlight.add(nodeId);
      const containerNames = (containers ?? []).map((c) => c.name);

      this.orphanCleaner
        .clean({ nodeId, runningContainers: containerNames })
        .catch((err) => {
          logger.error(`Orphan cleanup failed for node ${nodeId}`, {
            err: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.cleanupInFlight.delete(nodeId);
        });
    }

    // Transition unhealthy -> active through the state machine (with audit trail).
    // For "active" nodes: no transition needed, just update heartbeat timestamp.
    // For "returning" nodes: OrphanCleaner owns the transition, skip here.
    if (status === "unhealthy") {
      try {
        await this.nodeRepo.transition(nodeId, "active", "heartbeat_received", "heartbeat");
      } catch (err) {
        // ConcurrentTransitionError or InvalidTransitionError — status changed underneath us.
        // Log and continue; the heartbeat timestamp update below still applies.
        logger.debug(`Heartbeat transition skipped for ${nodeId}`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.nodeRepo.updateHeartbeat(nodeId, usedMb);

    logger.debug(`Heartbeat received from ${nodeId}`, { usedMb, status });
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
  async listNodes(): Promise<Node[]> {
    const nodes = await this.nodeRepo.list();
    return nodes;
  }

  /**
   * Get tenants assigned to a specific node
   */
  async getNodeTenants(nodeId: string): Promise<TenantAssignment[]> {
    const instances = await this.botInstanceRepo.listByNode(nodeId);

    return instances.map((inst) => ({
      id: inst.id,
      tenantId: inst.tenantId,
      name: inst.name,
      containerName: `tenant_${inst.tenantId}`,
      estimatedMb: 100, // Default estimate; can be refined from heartbeat data
    }));
  }

  /**
   * Find the best target node for recovery (most free capacity)
   */
  async findBestTarget(excludeNodeId: string, requiredMb: number): Promise<Node | null> {
    const node = await this.nodeRepo.findBestTarget(excludeNodeId, requiredMb);
    return node;
  }

  /**
   * Reassign a tenant to a new node (update bot_instances)
   */
  async reassignTenant(botId: string, targetNodeId: string): Promise<void> {
    await this.botInstanceRepo.reassign(botId, targetNodeId);
    logger.info(`Reassigned bot ${botId} to node ${targetNodeId}`);
  }

  /**
   * Update a node's used capacity
   */
  async addNodeCapacity(nodeId: string, deltaMb: number): Promise<void> {
    await this.nodeRepo.addCapacity(nodeId, deltaMb);
  }

  /**
   * Get a single node by ID
   */
  async getNode(nodeId: string): Promise<Node | undefined> {
    const node = await this.nodeRepo.getById(nodeId);
    return node ?? undefined;
  }

  /**
   * Check if a node is connected (has active WebSocket)
   */
  isConnected(nodeId: string): boolean {
    const ws = this.connections.get(nodeId);
    return ws != null && ws.readyState === 1;
  }

  /**
   * Register a self-hosted node with owner and per-node secret hash.
   */
  async registerSelfHostedNode(
    registration: NodeRegistration & {
      ownerUserId: string;
      label: string | null;
      nodeSecretHash: string;
    },
  ): Promise<void> {
    await this.nodeRepo.registerSelfHosted({
      nodeId: registration.node_id,
      host: registration.host,
      capacityMb: registration.capacity_mb,
      agentVersion: registration.agent_version,
      ownerUserId: registration.ownerUserId,
      label: registration.label,
      nodeSecretHash: registration.nodeSecretHash,
    });

    logger.info(`Self-hosted node ${registration.node_id} registered for user ${registration.ownerUserId}`);

    // Trigger auto-retry check for waiting recovery tenants
    if (this.onNodeRegistered) {
      this.onNodeRegistered();
    }
  }

  /**
   * Look up a node by its persistent secret (hashed). Returns node or undefined.
   */
  async getNodeBySecret(secret: string): Promise<Node | undefined> {
    const node = await this.nodeRepo.getBySecret(secret);
    return node ?? undefined;
  }

  /**
   * Remove a self-hosted node (deregister), closing any active WebSocket.
   */
  async removeNode(nodeId: string): Promise<void> {
    const ws = this.connections.get(nodeId);
    if (ws) {
      ws.close();
      this.connections.delete(nodeId);
    }
    await this.nodeRepo.delete(nodeId);
    logger.info(`Node ${nodeId} removed`);
  }
}
