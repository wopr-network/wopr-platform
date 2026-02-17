import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { WebSocket } from "ws";
import { logger } from "../config/logger.js";
import type * as schema from "../db/schema/index.js";
import { botInstances, nodes } from "../db/schema/index.js";

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
 */
export class NodeConnectionManager {
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingCommand>();

  constructor(db: BetterSQLite3Database<typeof schema>) {
    this.db = db;
  }

  /**
   * Register a new node (called from HTTP POST /internal/nodes/register)
   */
  registerNode(registration: NodeRegistration): void {
    const now = Math.floor(Date.now() / 1000);

    // Upsert: if node exists, update; otherwise insert
    const existing = this.db.select().from(nodes).where(eq(nodes.id, registration.node_id)).get();

    if (existing) {
      this.db
        .update(nodes)
        .set({
          host: registration.host,
          capacityMb: registration.capacity_mb,
          agentVersion: registration.agent_version,
          status: "active",
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(nodes.id, registration.node_id))
        .run();

      logger.info(`Node ${registration.node_id} re-registered`);
    } else {
      this.db
        .insert(nodes)
        .values({
          id: registration.node_id,
          host: registration.host,
          capacityMb: registration.capacity_mb,
          usedMb: 0,
          agentVersion: registration.agent_version,
          status: "active",
          lastHeartbeatAt: now,
          registeredAt: now,
          updatedAt: now,
        })
        .run();

      logger.info(`Node ${registration.node_id} registered`);
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
  private processHeartbeat(nodeId: string, msg: Record<string, unknown>): void {
    const now = Math.floor(Date.now() / 1000);
    const containers = msg.containers as Array<{ name: string; memory_mb: number }> | undefined;
    const usedMb = containers?.reduce((sum, c) => sum + (c.memory_mb ?? 0), 0) ?? 0;

    this.db
      .update(nodes)
      .set({
        lastHeartbeatAt: now,
        usedMb,
        status: "active", // If node was unhealthy, mark active again
        updatedAt: now,
      })
      .where(eq(nodes.id, nodeId))
      .run();

    logger.debug(`Heartbeat received from ${nodeId}`, { usedMb });
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
  listNodes(): NodeInfo[] {
    return this.db.select().from(nodes).all();
  }

  /**
   * Get tenants assigned to a specific node
   */
  getNodeTenants(nodeId: string): TenantAssignment[] {
    const instances = this.db.select().from(botInstances).where(eq(botInstances.nodeId, nodeId)).all();

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
  findBestTarget(excludeNodeId: string, requiredMb: number): NodeInfo | null {
    return (
      this.db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.status, "active"),
            ne(nodes.id, excludeNodeId),
            sql`(${nodes.capacityMb} - ${nodes.usedMb}) >= ${requiredMb}`,
          ),
        )
        .orderBy(desc(sql`${nodes.capacityMb} - ${nodes.usedMb}`)) // Most free capacity first
        .limit(1)
        .get() ?? null
    );
  }

  /**
   * Reassign a tenant to a new node (update bot_instances)
   */
  reassignTenant(botId: string, targetNodeId: string): void {
    this.db.update(botInstances).set({ nodeId: targetNodeId }).where(eq(botInstances.id, botId)).run();

    logger.info(`Reassigned bot ${botId} to node ${targetNodeId}`);
  }

  /**
   * Update a node's used capacity
   */
  addNodeCapacity(nodeId: string, deltaMb: number): void {
    this.db
      .update(nodes)
      .set({ usedMb: sql`${nodes.usedMb} + ${deltaMb}` })
      .where(eq(nodes.id, nodeId))
      .run();
  }

  /**
   * Get a single node by ID
   */
  getNode(nodeId: string): NodeInfo | undefined {
    return this.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  }

  /**
   * Check if a node is connected (has active WebSocket)
   */
  isConnected(nodeId: string): boolean {
    const ws = this.connections.get(nodeId);
    return ws != null && ws.readyState === 1;
  }
}
