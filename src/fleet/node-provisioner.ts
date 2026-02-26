import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import type { DrizzleDb } from "../db/index.js";
import { nodes } from "../db/schema/index.js";
import { generateCloudInit } from "./cloud-init.js";
import type { DOClient, DODroplet } from "./do-client.js";

export interface ProvisionNodeParams {
  region?: string;
  size?: string;
  name?: string;
}

export interface ProvisionResult {
  nodeId: string;
  host: string;
  dropletId: number;
  region: string;
  size: string;
  monthlyCostCents: number;
}

export class NodeProvisioningError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly nodeId?: string,
  ) {
    super(message);
    this.name = "NodeProvisioningError";
  }
}

export class NodeProvisioner {
  private readonly db: DrizzleDb;
  private readonly doClient: DOClient;
  private readonly sshKeyId: number;
  private readonly defaultRegion: string;
  private readonly defaultSize: string;
  private readonly botImage: string;

  constructor(
    db: DrizzleDb,
    doClient: DOClient,
    options: {
      sshKeyId: number;
      defaultRegion?: string;
      defaultSize?: string;
      botImage?: string;
    },
  ) {
    this.db = db;
    this.doClient = doClient;
    this.sshKeyId = options.sshKeyId;
    this.defaultRegion = options.defaultRegion ?? "nyc1";
    this.defaultSize = options.defaultSize ?? "s-4vcpu-8gb";
    this.botImage = options.botImage ?? "ghcr.io/wopr-network/wopr:latest";
  }

  /**
   * Provision a new node via DigitalOcean API.
   * Steps:
   * 1. Insert placeholder row in nodes table with provisionStage="creating"
   * 2. Call DO API to create droplet
   * 3. Poll until droplet status = "active"
   * 4. Update node row with IP, droplet ID
   * 5. Mark provisionStage="waiting_agent" — node agent self-registers when ready
   */
  async provision(params: ProvisionNodeParams = {}): Promise<ProvisionResult> {
    const region = params.region ?? this.defaultRegion;
    const size = params.size ?? this.defaultSize;
    const nodeId = params.name ?? `node-${randomUUID().slice(0, 8)}`;
    const now = Math.floor(Date.now() / 1000);

    // 1. Insert placeholder
    await this.db.insert(nodes).values({
      id: nodeId,
      host: "pending",
      status: "provisioning",
      capacityMb: 0,
      usedMb: 0,
      provisionStage: "creating",
      region,
      size,
      registeredAt: now,
      updatedAt: now,
    });

    try {
      // 2. Create droplet
      const userData = generateCloudInit(this.botImage);
      const droplet = await this.doClient.createDroplet({
        name: `wopr-${nodeId}`,
        region,
        size,
        image: "ubuntu-24-04-x64",
        ssh_keys: [this.sshKeyId],
        tags: ["wopr-node"],
        user_data: userData,
      });

      // 3. Poll until active
      await this.updateProvisionStage(nodeId, "waiting_active");
      const activeDroplet = await this.waitForDropletActive(droplet.id);

      // 4. Get public IP
      const publicIp = activeDroplet.networks.v4.find((n) => n.type === "public")?.ip_address;
      if (!publicIp) {
        throw new NodeProvisioningError("No public IP assigned", "waiting_active", nodeId);
      }

      const capacityMb = activeDroplet.size.memory;
      const monthlyCostCents = Math.round(activeDroplet.size.price_monthly * 100);

      // 5. Update node record with real data
      await this.updateProvisionStage(nodeId, "installing_docker");
      await this.db
        .update(nodes)
        .set({
          host: publicIp,
          dropletId: String(droplet.id),
          capacityMb,
          monthlyCostCents,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(nodes.id, nodeId));

      // 6. Mark as waiting_agent — the node agent will register itself via
      //    POST /internal/nodes/register when cloud-init completes, flipping
      //    status to "active" automatically via NodeConnectionManager.registerNode().
      await this.db
        .update(nodes)
        .set({
          provisionStage: "waiting_agent",
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(nodes.id, nodeId));

      logger.info(`Node ${nodeId} provisioned, waiting for agent registration`, {
        dropletId: droplet.id,
        host: publicIp,
        region,
        size,
      });

      return {
        nodeId,
        host: publicIp,
        dropletId: droplet.id,
        region,
        size,
        monthlyCostCents,
      };
    } catch (err) {
      await this.db
        .update(nodes)
        .set({
          status: "failed",
          provisionStage: "failed",
          lastError: err instanceof Error ? err.message : String(err),
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(nodes.id, nodeId));

      throw err;
    }
  }

  /**
   * Destroy a node: verify it's drained/empty, delete DO droplet, remove from DB.
   */
  async destroy(nodeId: string): Promise<void> {
    const rows = await this.db.select().from(nodes).where(eq(nodes.id, nodeId));
    const node = rows[0];
    if (!node) throw new Error(`Node ${nodeId} not found`);

    if (node.drainStatus !== "drained" && node.usedMb > 0) {
      throw new Error(`Node ${nodeId} must be drained before destruction. Current used: ${node.usedMb}MB`);
    }

    if (node.dropletId) {
      await this.doClient.deleteDroplet(Number(node.dropletId));
    }

    await this.db.delete(nodes).where(eq(nodes.id, nodeId));

    logger.info(`Node ${nodeId} destroyed`);
  }

  /** List available DO regions */
  async listRegions() {
    return this.doClient.listRegions();
  }

  /** List available DO sizes */
  async listSizes() {
    return this.doClient.listSizes();
  }

  private async updateProvisionStage(nodeId: string, stage: string): Promise<void> {
    await this.db
      .update(nodes)
      .set({
        provisionStage: stage,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(nodes.id, nodeId));
  }

  private async waitForDropletActive(dropletId: number, timeoutMs = 300_000): Promise<DODroplet> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const droplet = await this.doClient.getDroplet(dropletId);
      if (droplet.status === "active") return droplet;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new NodeProvisioningError(
      `Droplet ${dropletId} did not become active within ${timeoutMs}ms`,
      "waiting_active",
    );
  }
}
