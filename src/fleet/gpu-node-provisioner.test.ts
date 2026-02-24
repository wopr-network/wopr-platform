import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DOClient } from "./do-client.js";
import { GpuNodeProvisioner } from "./gpu-node-provisioner.js";
import type { IGpuNodeRepository } from "./gpu-node-repository.js";
import type { GpuNode } from "./repository-types.js";

function makeGpuNode(overrides: Partial<GpuNode> = {}): GpuNode {
  return {
    id: "gpu-test-1",
    dropletId: "12345",
    host: "10.0.0.1",
    region: "nyc1",
    size: "gpu-h100x1-80gb",
    status: "active",
    provisionStage: "complete",
    serviceHealth: null,
    monthlyCostCents: 250000,
    lastHealthAt: null,
    lastError: null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

describe("GpuNodeProvisioner", () => {
  let repo: IGpuNodeRepository;
  let doClient: Partial<DOClient>;
  let provisioner: GpuNodeProvisioner;

  beforeEach(() => {
    repo = {
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
    doClient = {
      createDroplet: vi.fn().mockResolvedValue({
        id: 12345,
        name: "gpu-test-1",
        status: "active",
        region: { slug: "nyc1", name: "New York 1" },
        size: { slug: "gpu-h100x1-80gb", memory: 81920, vcpus: 8, disk: 320, price_monthly: 2500 },
        networks: { v4: [{ ip_address: "10.0.0.1", type: "public" }] },
        created_at: "2024-01-01T00:00:00Z",
      }),
      getDroplet: vi.fn().mockResolvedValue({
        id: 12345,
        name: "gpu-test-1",
        status: "active",
        region: { slug: "nyc1", name: "New York 1" },
        size: { slug: "gpu-h100x1-80gb", memory: 81920, vcpus: 8, disk: 320, price_monthly: 2500 },
        networks: { v4: [{ ip_address: "10.0.0.1", type: "public" }] },
        created_at: "2024-01-01T00:00:00Z",
      }),
      deleteDroplet: vi.fn().mockResolvedValue(undefined),
    };
    provisioner = new GpuNodeProvisioner(repo, doClient as DOClient, {
      sshKeyId: 123,
      platformUrl: "https://api.wopr.bot",
      gpuNodeSecret: "test-secret",
    });
  });

  it("should provision a GPU node", async () => {
    const result = await provisioner.provision({ region: "nyc1", size: "gpu-h100x1-80gb" });
    expect(result.region).toBe("nyc1");
    expect(result.dropletId).toBe(12345);
    expect(repo.insert).toHaveBeenCalled();
    expect(doClient.createDroplet).toHaveBeenCalled();
  });

  it("should destroy a GPU node", async () => {
    (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeGpuNode({ status: "active", dropletId: "12345" }));
    await provisioner.destroy("gpu-test-1");
    expect(doClient.deleteDroplet).toHaveBeenCalledWith(12345);
    expect(repo.delete).toHaveBeenCalledWith("gpu-test-1");
  });

  it("should throw when node not found on destroy", async () => {
    (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await expect(provisioner.destroy("nonexistent")).rejects.toThrow(/not found/);
  });

  it("should use default region and size when not specified", async () => {
    await provisioner.provision();
    expect(doClient.createDroplet).toHaveBeenCalledWith(
      expect.objectContaining({ region: "nyc1", size: "gpu-h100x1-80gb" }),
    );
  });

  it("should mark node as failed on provisioning error", async () => {
    (doClient.createDroplet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DO API error"));
    await expect(provisioner.provision()).rejects.toThrow();
    expect(repo.updateStatus).toHaveBeenCalledWith(expect.any(String), "failed");
  });
});
