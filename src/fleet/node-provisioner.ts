import { createHash, randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import { generateCloudInit, validateBotImage } from "./cloud-init.js";
import type { FleetEventEmitter } from "./fleet-event-emitter.js";
import type { INodeProvider, ProviderRegion, ProviderSize } from "./node-provider.js";
import type { INodeRepository } from "./node-repository.js";

export interface ProvisionNodeParams {
  region?: string;
  size?: string;
  name?: string;
}

export interface ProvisionResult {
  nodeId: string;
  host: string;
  externalId: string;
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
  private readonly provider: INodeProvider;
  private readonly sshKeyId: number;
  private readonly defaultRegion: string;
  private readonly defaultSize: string;
  private readonly botImage: string;
  private readonly eventEmitter?: FleetEventEmitter;

  constructor(
    nodeRepo: INodeRepository,
    provider: INodeProvider,
    options: {
      sshKeyId: number;
      defaultRegion?: string;
      defaultSize?: string;
      botImage?: string;
    },
    eventEmitter?: FleetEventEmitter,
  ) {
    this.nodeRepo = nodeRepo;
    this.provider = provider;
    this.sshKeyId = options.sshKeyId;
    this.defaultRegion = options.defaultRegion ?? "nyc1";
    this.defaultSize = options.defaultSize ?? "s-4vcpu-8gb";
    this.botImage = options.botImage ?? "ghcr.io/wopr-network/wopr:latest";
    this.eventEmitter = eventEmitter;
    validateBotImage(this.botImage);
  }

  private emitNodeEvent(type: "node.provisioned" | "node.deprovisioned", nodeId: string): void {
    this.eventEmitter?.emit({ type, nodeId, timestamp: new Date().toISOString() });
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

    let createdExternalId: string | undefined;
    try {
      // 2. Create node via provider
      const userData = generateCloudInit(this.botImage, nodeSecret);
      const { externalId } = await this.provider.createNode({
        name: `wopr-${nodeId}`,
        region,
        size,
        sshKeyIds: [this.sshKeyId],
        tags: ["wopr-node"],
        userData,
      });
      createdExternalId = externalId;

      // 3. Poll until active
      await this.updateProvisionStage(nodeId, "waiting_active");
      const activeNode = await this.waitForNodeActive(externalId);

      // 4. Get public IP
      if (!activeNode.publicIp) {
        throw new NodeProvisioningError("No public IP assigned", "waiting_active", nodeId);
      }

      // 5. Update node record with real data
      await this.updateProvisionStage(nodeId, "installing_docker");
      await this.nodeRepo.updateProvisionData(nodeId, {
        host: activeNode.publicIp,
        dropletId: externalId,
        capacityMb: activeNode.memoryMb,
        monthlyCostCents: activeNode.monthlyCostCents,
      });

      // 6. Mark as waiting_agent — the node agent will register itself via
      //    POST /internal/nodes/register when cloud-init completes, flipping
      //    status to "active" automatically via NodeConnectionManager.registerNode().
      await this.updateProvisionStage(nodeId, "waiting_agent");

      logger.info(`Node ${nodeId} provisioned, waiting for agent registration`, {
        externalId,
        host: activeNode.publicIp,
        region,
        size,
      });

      this.emitNodeEvent("node.provisioned", nodeId);

      return {
        nodeId,
        host: activeNode.publicIp,
        externalId,
        region,
        size,
        monthlyCostCents: activeNode.monthlyCostCents,
      };
    } catch (err) {
      // Compensating action: destroy the node if it was created before the failure
      if (createdExternalId !== undefined) {
        try {
          await this.provider.deleteNode(createdExternalId);
          logger.info(`Cleaned up orphaned node ${createdExternalId} after provisioning failure`);
        } catch (cleanupErr) {
          logger.error(`Failed to clean up orphaned node ${createdExternalId}`, {
            cleanupError: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            originalError: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
      await this.provider.deleteNode(node.dropletId);
    }

    await this.nodeRepo.delete(nodeId);

    this.emitNodeEvent("node.deprovisioned", nodeId);

    logger.info(`Node ${nodeId} destroyed`);
  }

  /** List available regions from provider */
  async listRegions(): Promise<ProviderRegion[]> {
    return this.provider.listRegions();
  }

  /** List available sizes from provider */
  async listSizes(): Promise<ProviderSize[]> {
    return this.provider.listSizes();
  }

  private async updateProvisionStage(nodeId: string, stage: string): Promise<void> {
    await this.nodeRepo.updateProvisionStage(nodeId, stage);
  }

  private async waitForNodeActive(externalId: string, timeoutMs = 300_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const node = await this.provider.getNodeStatus(externalId);
      if (node.status === "active") return node;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new NodeProvisioningError(`Node ${externalId} did not become active within ${timeoutMs}ms`, "waiting_active");
  }
}
