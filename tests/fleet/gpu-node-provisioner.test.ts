import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DOClient, DODroplet, DORegion, DOSize } from "../../src/fleet/do-client.js";
import type { IGpuNodeRepository } from "../../src/fleet/gpu-node-repository.js";
import {
  GpuNodeProvisioner,
  GpuProvisioningError,
  type GpuProvisionResult,
} from "../../src/fleet/gpu-node-provisioner.js";
import type { GpuNode } from "../../src/fleet/repository-types.js";

function makeDroplet(overrides: Partial<DODroplet> = {}): DODroplet {
  return {
    id: 12345,
    name: "wopr-gpu-test",
    status: "active",
    region: { slug: "nyc1", name: "New York 1" },
    size: { slug: "gpu-h100x1-80gb", memory: 81920, vcpus: 8, disk: 320, price_monthly: 2999 },
    networks: { v4: [{ ip_address: "10.0.0.1", type: "public" }] },
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeGpuNode(overrides: Partial<GpuNode> = {}): GpuNode {
  return {
    id: "gpu-abc12345",
    dropletId: null,
    host: null,
    region: "nyc1",
    size: "gpu-h100x1-80gb",
    status: "provisioning",
    provisionStage: "pending",
    serviceHealth: null,
    monthlyCostCents: null,
    lastHealthAt: null,
    lastError: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockRepo(): IGpuNodeRepository {
  return {
    insert: vi.fn().mockReturnValue(makeGpuNode()),
    getById: vi.fn().mockReturnValue(makeGpuNode()),
    list: vi.fn().mockReturnValue([]),
    updateStage: vi.fn(),
    updateStatus: vi.fn(),
    updateHost: vi.fn(),
    updateServiceHealth: vi.fn(),
    setError: vi.fn(),
    delete: vi.fn(),
  };
}

function makeMockDoClient(): DOClient {
  return {
    createDroplet: vi.fn().mockResolvedValue(makeDroplet()),
    getDroplet: vi.fn().mockResolvedValue(makeDroplet()),
    deleteDroplet: vi.fn().mockResolvedValue(undefined),
    listRegions: vi.fn().mockResolvedValue([
      { slug: "nyc1", name: "New York 1", available: true, sizes: ["gpu-h100x1-80gb", "s-1vcpu-1gb"] },
    ] as DORegion[]),
    listSizes: vi.fn().mockResolvedValue([
      { slug: "gpu-h100x1-80gb", memory: 81920, vcpus: 8, disk: 320, price_monthly: 2999, available: true, regions: ["nyc1"], description: "GPU H100" },
      { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, available: true, regions: ["nyc1"], description: "Basic" },
    ] as DOSize[]),
  } as unknown as DOClient;
}

describe("GpuNodeProvisioner", () => {
  let repo: IGpuNodeRepository;
  let doClient: DOClient;
  let provisioner: GpuNodeProvisioner;

  beforeEach(() => {
    repo = makeMockRepo();
    doClient = makeMockDoClient();
    provisioner = new GpuNodeProvisioner(repo, doClient, {
      sshKeyId: 42,
      defaultRegion: "nyc1",
      defaultSize: "gpu-h100x1-80gb",
      platformUrl: "https://api.wopr.bot",
      gpuNodeSecret: "test-secret",
    });
  });

  describe("provision", () => {
    it("should insert a node, create a droplet, poll, and return result", async () => {
      const result = await provisioner.provision();

      expect(repo.insert).toHaveBeenCalledOnce();
      expect(repo.updateStage).toHaveBeenCalledWith(expect.any(String), "creating");
      expect(doClient.createDroplet).toHaveBeenCalledOnce();
      expect(repo.updateStage).toHaveBeenCalledWith(expect.any(String), "waiting_active");
      expect(repo.updateHost).toHaveBeenCalledWith(
        expect.any(String),
        "10.0.0.1",
        "12345",
        299900,
      );
      expect(repo.updateStage).toHaveBeenCalledWith(expect.any(String), "waiting_agent");

      expect(result).toMatchObject({
        host: "10.0.0.1",
        dropletId: 12345,
        region: "nyc1",
        size: "gpu-h100x1-80gb",
        monthlyCostCents: 299900,
      });
    });

    it("should use custom name when provided", async () => {
      const result = await provisioner.provision({ name: "my-gpu" });
      expect(result.nodeId).toBe("my-gpu");
      expect(repo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "my-gpu" }),
      );
    });

    it("should set error on repo if provisioning fails", async () => {
      (doClient.createDroplet as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("API down"),
      );

      await expect(provisioner.provision()).rejects.toThrow("API down");
      expect(repo.updateStatus).toHaveBeenCalledWith(expect.any(String), "failed");
      expect(repo.setError).toHaveBeenCalledWith(expect.any(String), "API down");
    });

    it("should throw GpuProvisioningError when no public IP", async () => {
      (doClient.getDroplet as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDroplet({
          networks: { v4: [{ ip_address: "10.0.0.1", type: "private" }] },
        }),
      );

      await expect(provisioner.provision()).rejects.toThrow(GpuProvisioningError);
    });

    it("should throw GpuProvisioningError on poll timeout", async () => {
      (doClient.getDroplet as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDroplet({ status: "new" }),
      );

      provisioner = new GpuNodeProvisioner(repo, doClient, {
        sshKeyId: 42,
        pollTimeoutMs: 100,
        pollIntervalMs: 10,
        platformUrl: "https://api.wopr.bot",
        gpuNodeSecret: "test-secret",
      });

      await expect(provisioner.provision()).rejects.toThrow(GpuProvisioningError);
    });
  });

  describe("destroy", () => {
    it("should delete droplet and repo record", async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeGpuNode({ id: "gpu-1", dropletId: "12345" }),
      );

      await provisioner.destroy("gpu-1");
      expect(doClient.deleteDroplet).toHaveBeenCalledWith(12345);
      expect(repo.delete).toHaveBeenCalledWith("gpu-1");
    });

    it("should throw if node not found", async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(null);
      await expect(provisioner.destroy("nonexistent")).rejects.toThrow("not found");
    });

    it("should skip droplet deletion if no dropletId", async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeGpuNode({ id: "gpu-1", dropletId: null }),
      );

      await provisioner.destroy("gpu-1");
      expect(doClient.deleteDroplet).not.toHaveBeenCalled();
      expect(repo.delete).toHaveBeenCalledWith("gpu-1");
    });
  });

  describe("listSizes", () => {
    it("should return only GPU sizes (slug starts with gpu-)", async () => {
      const sizes = await provisioner.listSizes();
      expect(sizes).toHaveLength(1);
      expect(sizes[0].slug).toBe("gpu-h100x1-80gb");
    });
  });

  describe("listRegions", () => {
    it("should return regions that have GPU sizes available", async () => {
      const regions = await provisioner.listRegions();
      expect(regions).toHaveLength(1);
      expect(regions[0].slug).toBe("nyc1");
    });
  });
});
