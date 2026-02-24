import { randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import type { DOClient } from "./do-client.js";
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

export class GpuNodeProvisioningError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly nodeId?: string,
  ) {
    super(message);
    this.name = "GpuNodeProvisioningError";
  }
}

export class GpuNodeProvisioner {
  private readonly repo: IGpuNodeRepository;
  private readonly doClient: DOClient;
  private readonly sshKeyId: number;
  private readonly defaultRegion: string;
  private readonly defaultSize: string;

  constructor(
    repo: IGpuNodeRepository,
    doClient: DOClient,
    options: {
      sshKeyId: number;
      defaultRegion?: string;
      defaultSize?: string;
    },
  ) {
    this.repo = repo;
    this.doClient = doClient;
    this.sshKeyId = options.sshKeyId;
    this.defaultRegion = options.defaultRegion ?? "nyc1";
    this.defaultSize = options.defaultSize ?? "gpu-h100x1-80gb";
  }

  async provision(params: GpuProvisionParams = {}): Promise<GpuProvisionResult> {
    const nodeId = `gpu-${randomUUID()}`;
    const region = params.region ?? this.defaultRegion;
    const size = params.size ?? this.defaultSize;
    const name = params.name ?? nodeId;

    this.repo.insert({ id: nodeId, region, size });

    try {
      this.repo.updateStage(nodeId, "creating_droplet");

      const droplet = await this.doClient.createDroplet({
        name,
        region,
        size,
        image: "ubuntu-22-04-x64",
        ssh_keys: [this.sshKeyId],
        tags: ["wopr", "gpu"],
      });

      const publicIp = droplet.networks.v4.find((n) => n.type === "public")?.ip_address ?? "";
      const monthlyCostCents = Math.round(droplet.size.price_monthly * 100);

      this.repo.updateHost(nodeId, publicIp, String(droplet.id), monthlyCostCents);
      this.repo.updateStage(nodeId, "bootstrapping");
      this.repo.updateStatus(nodeId, "bootstrapping");

      logger.info("GPU node provisioned", { nodeId, dropletId: droplet.id, region, size });

      return {
        nodeId,
        host: publicIp,
        dropletId: droplet.id,
        region,
        size,
        monthlyCostCents,
      };
    } catch (err) {
      this.repo.setError(nodeId, err instanceof Error ? err.message : "Unknown error");
      this.repo.updateStatus(nodeId, "failed");
      throw new GpuNodeProvisioningError(
        err instanceof Error ? err.message : "Provisioning failed",
        "creating_droplet",
        nodeId,
      );
    }
  }

  async destroy(nodeId: string): Promise<void> {
    const node = this.repo.getById(nodeId);
    if (!node) {
      throw new Error(`GPU node not found: ${nodeId}`);
    }

    if (node.status === "provisioning" || node.status === "bootstrapping") {
      throw new Error(
        `Cannot destroy GPU node in ${node.status} state — wait until provisioning/bootstrapping completes`,
      );
    }

    this.repo.updateStatus(nodeId, "destroying");

    if (node.dropletId) {
      await this.doClient.deleteDroplet(Number(node.dropletId));
    }

    this.repo.delete(nodeId);
    logger.info("GPU node destroyed", { nodeId });
  }
}
