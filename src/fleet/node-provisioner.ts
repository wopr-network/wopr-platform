import { createHash, randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import { generateCloudInit } from "./cloud-init.js";
import type { DOClient, DODroplet } from "./do-client.js";
import type { INodeRepository } from "./node-repository.js";

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
  private readonly nodeRepo: INodeRepository;
  private readonly doClient: DOClient;
  private readonly sshKeyId: number;
  private readonly defaultRegion: string;
  private readonly defaultSize: string;
  private readonly botImage: string;

  constructor(
    nodeRepo: INodeRepository,
    doClient: DOClient,
    options: {
      sshKeyId: number;
      defaultRegion?: string;
      defaultSize?: string;
      botImage?: string;
    },
  ) {
    this.nodeRepo = nodeRepo;
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

    // Generate per-node secret for cloud-init injection and hash for DB storage
    const nodeSecret = `wopr_node_${randomUUID().replace(/-/g, "")}`;
    const nodeSecretHash = createHash("sha256").update(nodeSecret).digest("hex");

    // 1. Insert placeholder
    await this.nodeRepo.insertProvisioning({
      id: nodeId,
      host: "pending",
      region,
      size,
      nodeSecretHash,
    });

    try {
      // 2. Create droplet
      const userData = generateCloudInit(this.botImage, nodeSecret);
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
      await this.nodeRepo.updateProvisionData(nodeId, {
        host: publicIp,
        dropletId: String(droplet.id),
        capacityMb,
        monthlyCostCents,
      });

      // 6. Mark as waiting_agent — the node agent will register itself via
      //    POST /internal/nodes/register when cloud-init completes, flipping
      //    status to "active" automatically via NodeConnectionManager.registerNode().
      await this.updateProvisionStage(nodeId, "waiting_agent");

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
      await this.nodeRepo.markFailed(nodeId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Destroy a node: verify it's drained/empty, delete DO droplet, remove from DB.
   */
  async destroy(nodeId: string): Promise<void> {
    const node = await this.nodeRepo.getById(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    if (node.drainStatus !== "drained" && node.usedMb > 0) {
      throw new Error(`Node ${nodeId} must be drained before destruction. Current used: ${node.usedMb}MB`);
    }

    if (node.dropletId) {
      await this.doClient.deleteDroplet(Number(node.dropletId));
    }

    await this.nodeRepo.delete(nodeId);

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
    await this.nodeRepo.updateProvisionStage(nodeId, stage);
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
