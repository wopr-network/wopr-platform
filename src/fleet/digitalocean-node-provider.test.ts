import { beforeEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanNodeProvider } from "./digitalocean-node-provider.js";
import type { DOClient } from "./do-client.js";

function makeDOClient(overrides: Partial<DOClient> = {}): DOClient {
  return {
    createDroplet: vi.fn().mockResolvedValue({ id: 12345 }),
    getDroplet: vi.fn().mockResolvedValue({
      id: 12345,
      name: "wopr-node-1",
      status: "active",
      region: { slug: "nyc1", name: "New York 1" },
      size: { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, price_monthly: 48 },
      networks: { v4: [{ ip_address: "1.2.3.4", type: "public" }] },
      created_at: "2026-01-01T00:00:00Z",
    }),
    deleteDroplet: vi.fn().mockResolvedValue(undefined),
    rebootDroplet: vi.fn().mockResolvedValue(undefined),
    listRegions: vi
      .fn()
      .mockResolvedValue([{ slug: "nyc1", name: "New York 1", available: true, sizes: ["s-4vcpu-8gb"] }]),
    listSizes: vi.fn().mockResolvedValue([
      {
        slug: "s-4vcpu-8gb",
        memory: 8192,
        vcpus: 4,
        disk: 160,
        price_monthly: 48,
        available: true,
        regions: ["nyc1"],
        description: "Basic",
      },
    ]),
    ...overrides,
  } as unknown as DOClient;
}

describe("DigitalOceanNodeProvider", () => {
  let doClient: DOClient;
  let provider: DigitalOceanNodeProvider;

  beforeEach(() => {
    doClient = makeDOClient();
    provider = new DigitalOceanNodeProvider(doClient);
  });

  describe("createNode", () => {
    it("calls createDroplet and returns externalId as string", async () => {
      const result = await provider.createNode({
        name: "wopr-node-1",
        region: "nyc1",
        size: "s-4vcpu-8gb",
        sshKeyIds: [123],
        tags: ["wopr-node"],
        userData: "#!/bin/bash\necho hello",
      });

      expect(result.externalId).toBe("12345");
      expect(doClient.createDroplet).toHaveBeenCalledWith({
        name: "wopr-node-1",
        region: "nyc1",
        size: "s-4vcpu-8gb",
        image: "ubuntu-24-04-x64",
        ssh_keys: [123],
        tags: ["wopr-node"],
        user_data: "#!/bin/bash\necho hello",
      });
    });
  });

  describe("deleteNode", () => {
    it("calls deleteDroplet with numeric ID", async () => {
      await provider.deleteNode("12345");
      expect(doClient.deleteDroplet).toHaveBeenCalledWith(12345);
    });
  });

  describe("getNodeStatus", () => {
    it("maps DO droplet to ProviderNode", async () => {
      const status = await provider.getNodeStatus("12345");
      expect(status).toEqual({
        externalId: "12345",
        status: "active",
        publicIp: "1.2.3.4",
        memoryMb: 8192,
        monthlyCostCents: 4800,
      });
    });

    it("maps 'new' status to 'pending'", async () => {
      (doClient.getDroplet as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 12345,
        name: "test",
        status: "new",
        region: { slug: "nyc1", name: "NYC" },
        size: { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, price_monthly: 48 },
        networks: { v4: [] },
        created_at: "2026-01-01T00:00:00Z",
      });

      const status = await provider.getNodeStatus("12345");
      expect(status.status).toBe("pending");
      expect(status.publicIp).toBeNull();
    });
  });

  describe("listRegions", () => {
    it("maps DO regions to ProviderRegion", async () => {
      const regions = await provider.listRegions();
      expect(regions).toEqual([{ slug: "nyc1", name: "New York 1", available: true }]);
    });
  });

  describe("listSizes", () => {
    it("maps DO sizes to ProviderSize", async () => {
      const sizes = await provider.listSizes();
      expect(sizes).toEqual([
        {
          slug: "s-4vcpu-8gb",
          memoryMb: 8192,
          vcpus: 4,
          diskGb: 160,
          monthlyCostCents: 4800,
          available: true,
          regions: ["nyc1"],
          description: "Basic",
        },
      ]);
    });
  });
});
