import type { DOClient } from "./do-client.js";
import type { CreateNodeSpec, INodeProvider, ProviderNode, ProviderRegion, ProviderSize } from "./node-provider.js";

const DO_STATUS_MAP: Record<string, ProviderNode["status"]> = {
  new: "pending",
  active: "active",
  off: "off",
  archive: "off",
};

export class DigitalOceanNodeProvider implements INodeProvider {
  constructor(private readonly doClient: DOClient) {}

  async createNode(spec: CreateNodeSpec): Promise<{ externalId: string }> {
    const droplet = await this.doClient.createDroplet({
      name: spec.name,
      region: spec.region,
      size: spec.size,
      image: "ubuntu-24-04-x64",
      ssh_keys: spec.sshKeyIds,
      tags: spec.tags,
      user_data: spec.userData,
    });
    return { externalId: String(droplet.id) };
  }

  async deleteNode(externalId: string): Promise<void> {
    await this.doClient.deleteDroplet(Number(externalId));
  }

  async getNodeStatus(externalId: string): Promise<ProviderNode> {
    const droplet = await this.doClient.getDroplet(Number(externalId));
    const publicIp = droplet.networks.v4.find((n) => n.type === "public")?.ip_address ?? null;
    return {
      externalId: String(droplet.id),
      status: DO_STATUS_MAP[droplet.status] ?? "error",
      publicIp,
      memoryMb: droplet.size.memory,
      monthlyCostCents: Math.round(droplet.size.price_monthly * 100),
    };
  }

  async listRegions(): Promise<ProviderRegion[]> {
    const regions = await this.doClient.listRegions();
    return regions.map((r) => ({ slug: r.slug, name: r.name, available: r.available }));
  }

  async listSizes(): Promise<ProviderSize[]> {
    const sizes = await this.doClient.listSizes();
    return sizes.map((s) => ({
      slug: s.slug,
      memoryMb: s.memory,
      vcpus: s.vcpus,
      diskGb: s.disk,
      monthlyCostCents: Math.round(s.price_monthly * 100),
      available: s.available,
      regions: s.regions,
      description: s.description,
    }));
  }
}
