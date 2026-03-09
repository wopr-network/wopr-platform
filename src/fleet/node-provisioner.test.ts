import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetEventEmitter } from "./fleet-event-emitter.js";
import type { INodeProvider, ProviderNode } from "./node-provider.js";
import { NodeProvisioner, NodeProvisioningError } from "./node-provisioner.js";
import type { INodeRepository } from "./node-repository.js";

const NODE_ID = "node-abc12345";
const EXTERNAL_ID = "12345";
const PUBLIC_IP = "1.2.3.4";

function makeProviderNode(overrides: Partial<ProviderNode> = {}): ProviderNode {
  return {
    externalId: EXTERNAL_ID,
    status: "active",
    publicIp: PUBLIC_IP,
    memoryMb: 8192,
    monthlyCostCents: 4800,
    ...overrides,
  };
}

function makeNodeProvider(overrides: Partial<INodeProvider> = {}): INodeProvider {
  return {
    createNode: vi.fn().mockResolvedValue({ externalId: EXTERNAL_ID }),
    deleteNode: vi.fn().mockResolvedValue(undefined),
    getNodeStatus: vi.fn().mockResolvedValue(makeProviderNode()),
    listRegions: vi.fn().mockResolvedValue([]),
    listSizes: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeNodeRepo(nodeRow?: Record<string, unknown>): INodeRepository {
  const node = nodeRow ?? null;
  return {
    getById: vi.fn().mockResolvedValue(node),
    getBySecret: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    register: vi.fn().mockResolvedValue(node),
    registerSelfHosted: vi.fn().mockResolvedValue(node),
    transition: vi.fn().mockResolvedValue(node),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    addCapacity: vi.fn().mockResolvedValue(undefined),
    findBestTarget: vi.fn().mockResolvedValue(null),
    listTransitions: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    verifyNodeSecret: vi.fn().mockResolvedValue(null),
    insertProvisioning: vi.fn().mockResolvedValue(node),
    updateProvisionData: vi.fn().mockResolvedValue(undefined),
    updateProvisionStage: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue(null),
    updateHeartbeatWithStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as INodeRepository;
}

describe("NodeProvisioner", () => {
  let provider: INodeProvider;

  beforeEach(() => {
    provider = makeNodeProvider();
    vi.clearAllMocks();
  });

  describe("provision", () => {
    it("inserts placeholder, calls provider, and returns result", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      const result = await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(provider.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "nyc1",
          size: "s-4vcpu-8gb",
          sshKeyIds: [123],
          tags: ["wopr-node"],
        }),
      );
      expect(nodeRepo.insertProvisioning).toHaveBeenCalled();
      expect(result.host).toBe(PUBLIC_IP);
      expect(result.externalId).toBe(EXTERNAL_ID);
      expect(result.region).toBe("nyc1");
      expect(result.size).toBe("s-4vcpu-8gb");
      expect(result.monthlyCostCents).toBe(4800);
    });

    it("auto-generates nodeId when name not provided", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      const result = await provisioner.provision();

      expect(result.nodeId).toMatch(/^node-[a-f0-9]{8}$/);
    });

    it("uses provided name", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      const result = await provisioner.provision({ name: "my-custom-node" });

      expect(result.nodeId).toBe("my-custom-node");
    });

    it("uses default region and size when not provided", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, provider, {
        sshKeyId: 123,
        defaultRegion: "sfo3",
        defaultSize: "s-2vcpu-4gb",
      });

      await provisioner.provision();

      expect(provider.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ region: "sfo3", size: "s-2vcpu-4gb" }),
      );
    });

    it("generates per-node secret hash and stores it in the initial insert", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(nodeRepo.insertProvisioning).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA-256 hex
        }),
      );
    });

    it("injects WOPR_NODE_SECRET into cloud-init user_data", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(provider.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          userData: expect.stringContaining("WOPR_NODE_SECRET="),
        }),
      );
    });

    it("marks node as failed on provider error", async () => {
      const failingProvider = makeNodeProvider({
        createNode: vi.fn().mockRejectedValue(new Error("Invalid region")),
      });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, failingProvider, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("Invalid region");

      expect(nodeRepo.markFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("Invalid region"));
    });

    it("cleans up node when DB write fails after createNode succeeds", async () => {
      const nodeRepo = makeNodeRepo();
      // Make updateProvisionData (the DB write after node is created) fail
      (nodeRepo.updateProvisionData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB write failed"));

      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("DB write failed");

      expect(provider.deleteNode).toHaveBeenCalledWith(EXTERNAL_ID);
    });

    it("still throws original error when node cleanup also fails", async () => {
      const failingDeleteProvider = makeNodeProvider({
        deleteNode: vi.fn().mockRejectedValue(new Error("Provider API unreachable")),
      });
      const nodeRepo = makeNodeRepo();
      (nodeRepo.updateProvisionData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB write failed"));

      const provisioner = new NodeProvisioner(nodeRepo, failingDeleteProvider, { sshKeyId: 123 });

      // Original error is preserved, not the cleanup error
      await expect(provisioner.provision()).rejects.toThrow("DB write failed");

      expect(failingDeleteProvider.deleteNode).toHaveBeenCalledWith(EXTERNAL_ID);
    });

    it("throws NodeProvisioningError when no public IP assigned", async () => {
      const noIpProvider = makeNodeProvider({
        getNodeStatus: vi.fn().mockResolvedValue(makeProviderNode({ publicIp: null })),
      });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, noIpProvider, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("No public IP");
    });
  });

  describe("destroy", () => {
    it("deletes via provider and removes node from DB when drained", async () => {
      const drained = { id: NODE_ID, drainStatus: "drained", usedMb: 0, dropletId: EXTERNAL_ID };
      const nodeRepo = makeNodeRepo(drained);
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await provisioner.destroy(NODE_ID);

      expect(provider.deleteNode).toHaveBeenCalledWith(EXTERNAL_ID);
      expect(nodeRepo.delete).toHaveBeenCalledWith(NODE_ID);
    });

    it("deletes node from DB when usedMb is 0 even without drainStatus", async () => {
      const empty = { id: NODE_ID, drainStatus: null, usedMb: 0, dropletId: null };
      const nodeRepo = makeNodeRepo(empty);
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await provisioner.destroy(NODE_ID);

      expect(provider.deleteNode).not.toHaveBeenCalled(); // no dropletId
      expect(nodeRepo.delete).toHaveBeenCalledWith(NODE_ID);
    });

    it("throws when node not found", async () => {
      const nodeRepo = makeNodeRepo(undefined);
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await expect(provisioner.destroy("nonexistent")).rejects.toThrow("not found");
    });

    it("throws when node has bots and is not drained", async () => {
      const active = { id: NODE_ID, drainStatus: null, usedMb: 500, dropletId: EXTERNAL_ID };
      const nodeRepo = makeNodeRepo(active);
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 });

      await expect(provisioner.destroy(NODE_ID)).rejects.toThrow("must be drained");
    });
  });

  describe("listRegions and listSizes", () => {
    it("delegates to provider.listRegions", async () => {
      const regions = [{ slug: "nyc1", name: "New York 1", available: true }];
      const p = makeNodeProvider({ listRegions: vi.fn().mockResolvedValue(regions) });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, p, { sshKeyId: 123 });

      const result = await provisioner.listRegions();
      expect(result).toEqual(regions);
    });

    it("delegates to provider.listSizes", async () => {
      const sizes = [
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
      ];
      const p = makeNodeProvider({ listSizes: vi.fn().mockResolvedValue(sizes) });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, p, { sshKeyId: 123 });

      const result = await provisioner.listSizes();
      expect(result).toEqual(sizes);
    });
  });

  describe("constructor validation", () => {
    it("rejects invalid botImage at construction time", () => {
      const nodeRepo = makeNodeRepo();
      expect(
        () =>
          new NodeProvisioner(nodeRepo, provider, {
            sshKeyId: 12345,
            botImage: "image; rm -rf /",
          }),
      ).toThrow("Invalid botImage");
    });
  });

  describe("node lifecycle events", () => {
    function makeEventEmitter(): FleetEventEmitter {
      return { emit: vi.fn(), subscribe: vi.fn() } as unknown as FleetEventEmitter;
    }

    it("emits node.provisioned on successful provision", async () => {
      const nodeRepo = makeNodeRepo();
      const emitter = makeEventEmitter();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 }, emitter);

      const result = await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(emitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "node.provisioned", nodeId: result.nodeId }),
      );
    });

    it("does not emit node.provisioned on failure", async () => {
      const failingProvider = makeNodeProvider({
        createNode: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const nodeRepo = makeNodeRepo();
      const emitter = makeEventEmitter();
      const provisioner = new NodeProvisioner(nodeRepo, failingProvider, { sshKeyId: 123 }, emitter);

      await expect(provisioner.provision()).rejects.toThrow();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("emits node.deprovisioned on successful destroy", async () => {
      const drained = { id: NODE_ID, drainStatus: "drained", usedMb: 0, dropletId: EXTERNAL_ID };
      const nodeRepo = makeNodeRepo(drained);
      const emitter = makeEventEmitter();
      const provisioner = new NodeProvisioner(nodeRepo, provider, { sshKeyId: 123 }, emitter);

      await provisioner.destroy(NODE_ID);

      expect(emitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "node.deprovisioned", nodeId: NODE_ID }),
      );
    });
  });

  describe("NodeProvisioningError", () => {
    it("has correct name and stage", () => {
      const err = new NodeProvisioningError("test message", "creating", "node-1");
      expect(err.name).toBe("NodeProvisioningError");
      expect(err.stage).toBe("creating");
      expect(err.nodeId).toBe("node-1");
      expect(err.message).toBe("test message");
    });
  });
});
