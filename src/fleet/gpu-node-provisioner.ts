import { randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import type { DOClient, DODroplet, DORegion, DOSize } from "./do-client.js";
import { generateGpuCloudInit } from "./gpu-cloud-init.js";
import type { IGpuNodeRepository } from "./gpu-node-repository.js";

export interface GpuProvisionParams {
  region?: string;
  size?: string;
  name?: string;
}

export interface GpuProvisionResult {
  nodeId: string;
  host: string;
  dropletId: number;
  region: string;
  size: string;
  monthlyCostCents: number;
}

export class GpuProvisioningError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly nodeId?: string,
  ) {
    super(message);
    this.name = "GpuProvisioningError";
  }
}

export class GpuNodeProvisioner {
  private readonly repo: IGpuNodeRepository;
  private readonly doClient: DOClient;
  private readonly sshKeyId: number;
  private readonly defaultRegion: string;
  private readonly defaultSize: string;
  private readonly platformUrl: string;
  private readonly gpuNodeSecret: string;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    repo: IGpuNodeRepository,
    doClient: DOClient,
    options: {
      sshKeyId: number;
      defaultRegion?: string;
      defaultSize?: string;
      platformUrl?: string;
      gpuNodeSecret?: string;
      pollTimeoutMs?: number;
      pollIntervalMs?: number;
    },
  ) {
    this.repo = repo;
    this.doClient = doClient;
    this.sshKeyId = options.sshKeyId;
    this.defaultRegion = options.defaultRegion ?? "nyc1";
    this.defaultSize = options.defaultSize ?? "gpu-h100x1-80gb";
    this.platformUrl = options.platformUrl ?? "https://api.wopr.bot";
    this.gpuNodeSecret = options.gpuNodeSecret ?? "";
    this.pollTimeoutMs = options.pollTimeoutMs ?? 300_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  /**
   * Provision a new GPU node via DigitalOcean API.
   * Steps:
   * 1. Insert placeholder row via repo with provisionStage="creating"
   * 2. Call DO API to create droplet with GPU cloud-init
   * 3. Poll until droplet status = "active"
   * 4. Update node row with IP, droplet ID via repo
   * 5. Mark provisionStage="waiting_agent"
   */
  async provision(params: GpuProvisionParams = {}): Promise<GpuProvisionResult> {
    const region = params.region ?? this.defaultRegion;
    const size = params.size ?? this.defaultSize;
    const nodeId = params.name ?? `gpu-${randomUUID().slice(0, 8)}`;

    // 1. Insert placeholder
    this.repo.insert({ id: nodeId, region, size });
    this.repo.updateStage(nodeId, "creating");

    try {
      // 2. Create droplet
      const userData = generateGpuCloudInit({
        nodeId,
        platformUrl: this.platformUrl,
        gpuNodeSecret: this.gpuNodeSecret,
      });
      const droplet = await this.doClient.createDroplet({
        name: `wopr-${nodeId}`,
        region,
        size,
        image: "gpu-h100x1-80gb-ubuntu-22-04",
        ssh_keys: [this.sshKeyId],
        tags: ["wopr-gpu-node"],
        user_data: userData,
      });

      // 3. Poll until active
      this.repo.updateStage(nodeId, "waiting_active");
      const activeDroplet = await this.waitForDropletActive(droplet.id);

      // 4. Get public IP
      const publicIp = activeDroplet.networks.v4.find((n) => n.type === "public")?.ip_address;
      if (!publicIp) {
        throw new GpuProvisioningError("No public IP assigned", "waiting_active", nodeId);
      }

      const monthlyCostCents = Math.round(activeDroplet.size.price_monthly * 100);

      // 5. Update node record with real data
      this.repo.updateHost(nodeId, publicIp, String(droplet.id), monthlyCostCents);
      this.repo.updateStage(nodeId, "waiting_agent");

      logger.info(`GPU node ${nodeId} provisioned, waiting for agent registration`, {
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
      this.repo.updateStatus(nodeId, "failed");
      this.repo.setError(nodeId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Destroy a GPU node: delete DO droplet, remove repo record.
   */
  async destroy(nodeId: string): Promise<void> {
    const node = this.repo.getById(nodeId);
    if (!node) throw new Error(`GPU node ${nodeId} not found`);

    if (node.dropletId) {
      await this.doClient.deleteDroplet(Number(node.dropletId));
    }

    this.repo.delete(nodeId);
    logger.info(`GPU node ${nodeId} destroyed`);
  }

  /** List available DO regions that support GPU sizes. */
  async listRegions(): Promise<DORegion[]> {
    const [regions, sizes] = await Promise.all([this.doClient.listRegions(), this.doClient.listSizes()]);
    const gpuSlugs = new Set(sizes.filter((s) => s.slug.startsWith("gpu-")).flatMap((s) => s.regions));
    return regions.filter((r) => gpuSlugs.has(r.slug));
  }

  /** List available GPU sizes only (slug starts with "gpu-"). */
  async listSizes(): Promise<DOSize[]> {
    const sizes = await this.doClient.listSizes();
    return sizes.filter((s) => s.slug.startsWith("gpu-"));
  }

  private async waitForDropletActive(dropletId: number): Promise<DODroplet> {
    const start = Date.now();
    while (Date.now() - start < this.pollTimeoutMs) {
      const droplet = await this.doClient.getDroplet(dropletId);
      if (droplet.status === "active") return droplet;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    throw new GpuProvisioningError(
      `Droplet ${dropletId} did not become active within ${this.pollTimeoutMs}ms`,
      "waiting_active",
    );
  }
}
