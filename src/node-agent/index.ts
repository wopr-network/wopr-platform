import { hostname, networkInterfaces, totalmem } from "node:os";
import { WebSocket } from "ws";
import { logger } from "../config/logger.js";
import { BackupManager } from "./backup.js";
import { DockerManager } from "./docker.js";
import { HealthMonitor } from "./health.js";
import { collectHeartbeat } from "./heartbeat.js";
import {
  AGENT_VERSION,
  ALLOWED_COMMANDS,
  type Command,
  type CommandResult,
  type CommandType,
  commandSchema,
  type HealthEvent,
  type NodeAgentConfig,
  type NodeRegistration,
  nodeAgentConfigSchema,
} from "./types.js";

/** Maximum WebSocket reconnect delay (30 seconds) */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Initial reconnect delay (1 second) */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/**
 * The node agent: a lightweight daemon that runs on every worker node.
 *
 * - Registers with platform API on boot
 * - Maintains WebSocket connection for heartbeat + commands
 * - Monitors container health via Docker events
 * - Executes commands from the platform (start, stop, export, etc.)
 */
export class NodeAgent {
  private readonly config: NodeAgentConfig;
  private readonly dockerManager: DockerManager;
  private readonly backupManager: BackupManager;
  private readonly healthMonitor: HealthMonitor;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopped = false;

  constructor(config: NodeAgentConfig, dockerManager?: DockerManager) {
    this.config = config;
    this.dockerManager = dockerManager ?? new DockerManager();
    this.backupManager = new BackupManager(this.dockerManager, config.backupDir, config.s3Bucket);
    this.healthMonitor = new HealthMonitor(this.dockerManager, config.nodeId, (event) => this.sendHealthEvent(event));
  }

  /** Boot the agent: register, connect WebSocket, start monitoring. */
  async start(): Promise<void> {
    this.stopped = false;
    logger.info(`Node agent ${this.config.nodeId} starting (v${AGENT_VERSION})`);

    await this.register();
    this.connect();
    await this.healthMonitor.start();
  }

  /** Gracefully shut down the agent. */
  stop(): void {
    this.stopped = true;
    this.healthMonitor.stop();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info("Node agent stopped");
  }

  /** Register with the platform API via HTTP POST. */
  private async register(): Promise<void> {
    const url = `${this.config.platformUrl}/internal/nodes/register`;
    const body: NodeRegistration = {
      node_id: this.config.nodeId,
      host: getLocalIp(),
      capacity_mb: Math.round(totalmem() / 1024 / 1024),
      agent_version: AGENT_VERSION,
    };

    logger.info(`Registering with platform: ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.nodeSecret}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Registration failed (${response.status}): ${text}`);
    }

    logger.info("Registered with platform");
  }

  /** Establish WebSocket connection with auto-reconnect. */
  private connect(): void {
    if (this.stopped) return;

    const wsUrl = `${this.config.platformUrl.replace(/^http/, "ws")}/internal/nodes/${this.config.nodeId}/ws`;

    logger.info(`Connecting WebSocket: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${this.config.nodeSecret}`,
      },
    });

    this.ws.on("open", () => {
      logger.info("WebSocket connected");
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.startHeartbeat();
    });

    this.ws.on("message", (data: Buffer) => {
      this.handleMessage(data);
    });

    this.ws.on("close", () => {
      logger.warn("WebSocket closed");
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      logger.error("WebSocket error", { err: err.message });
    });
  }

  /** Schedule a reconnection with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.stopped) return;

    logger.info(`Reconnecting in ${this.reconnectDelay}ms`);
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  /** Start sending heartbeat at configured interval. */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    const sendHeartbeat = async () => {
      try {
        const heartbeat = await collectHeartbeat(this.config.nodeId, this.dockerManager);
        this.send(heartbeat);
      } catch (err) {
        logger.error("Failed to send heartbeat", { err });
      }
    };

    // Send first heartbeat immediately
    sendHeartbeat();
    this.heartbeatTimer = setInterval(sendHeartbeat, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Handle an inbound WebSocket message (command from platform). */
  private handleMessage(data: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      logger.warn("Received non-JSON WebSocket message");
      return;
    }

    const result = commandSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn("Received invalid command", { errors: result.error.issues });
      // If there's an id field, send back an error result
      const raw = parsed as Record<string, unknown>;
      if (typeof raw.id === "string") {
        this.send({
          id: raw.id,
          type: "command_result",
          command: raw.type ?? "unknown",
          success: false,
          error: `Invalid command: ${result.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      return;
    }

    this.executeCommand(result.data);
  }

  /** Dispatch and execute a validated command. */
  private async executeCommand(command: Command): Promise<void> {
    // Double-check command is in allowlist (Zod already validates, but belt-and-suspenders)
    if (!(ALLOWED_COMMANDS as readonly string[]).includes(command.type)) {
      this.sendResult(command.id, command.type, false, undefined, `Unknown command: ${command.type}`);
      return;
    }

    logger.info(`Executing command: ${command.type}`, { commandId: command.id });

    try {
      const data = await this.dispatch(command);
      this.sendResult(command.id, command.type, true, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Command ${command.type} failed`, { commandId: command.id, err: message });
      this.sendResult(command.id, command.type, false, undefined, message);
    }
  }

  /** Route a command to the appropriate handler. */
  private async dispatch(command: Command): Promise<unknown> {
    const p = command.payload as Record<string, string>;

    switch (command.type) {
      case "bot.start":
        return this.dockerManager.startBot({
          name: p.name,
          image: p.image,
          env: p.env ? JSON.parse(p.env) : undefined,
          restart: p.restart,
        });

      case "bot.stop":
        return this.dockerManager.stopBot(p.name);

      case "bot.restart":
        return this.dockerManager.restartBot(p.name);

      case "bot.export":
        return this.dockerManager.exportBot(p.name, this.config.backupDir);

      case "bot.import":
        return this.dockerManager.importBot(
          p.name,
          this.config.backupDir,
          p.image,
          p.env ? JSON.parse(p.env) : undefined,
        );

      case "bot.remove":
        return this.dockerManager.removeBot(p.name);

      case "bot.logs":
        return this.dockerManager.getLogs(p.name, p.tail ? Number.parseInt(p.tail, 10) : 100);

      case "bot.inspect":
        return this.dockerManager.inspectBot(p.name);

      case "backup.upload":
        return this.backupManager.upload(p.filename);

      case "backup.download":
        return this.backupManager.download(p.filename);

      case "backup.run-nightly":
        return this.backupManager.runNightly();

      default:
        throw new Error(`Unhandled command: ${command.type}`);
    }
  }

  /** Send a command result back over WebSocket. */
  private sendResult(id: string, command: CommandType, success: boolean, data?: unknown, error?: string): void {
    const result: CommandResult = { id, type: "command_result", command, success };
    if (data !== undefined) result.data = data;
    if (error) result.error = error;
    this.send(result);
  }

  /** Send a health event over WebSocket. */
  private sendHealthEvent(event: HealthEvent): void {
    this.send(event);
  }

  /** Send JSON payload over WebSocket. */
  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}

/** Get the first non-loopback IPv4 address. */
function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const addrs = nets[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return hostname();
}

// ---------------------------------------------------------------------------
// CLI entrypoint — only runs when executed directly
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith("node-agent/index.js") || process.argv[1]?.endsWith("node-agent/index.ts");

if (isMain) {
  const config = nodeAgentConfigSchema.parse({
    platformUrl: process.env.PLATFORM_URL,
    nodeId: process.env.NODE_ID,
    nodeSecret: process.env.NODE_SECRET,
    heartbeatIntervalMs: process.env.HEARTBEAT_INTERVAL_MS,
    backupDir: process.env.BACKUP_DIR,
    s3Bucket: process.env.S3_BUCKET,
  });

  const agent = new NodeAgent(config);

  const shutdown = () => {
    logger.info("Shutting down...");
    agent.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  agent.start().catch((err) => {
    logger.error("Failed to start node agent", { err });
    process.exit(1);
  });
}
