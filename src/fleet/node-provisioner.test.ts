import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DOClient } from "./do-client.js";
import { DOApiError } from "./do-client.js";
import { NodeProvisioner, NodeProvisioningError } from "./node-provisioner.js";
import type { INodeRepository } from "./node-repository.js";

const NODE_ID = "node-abc12345";
const DROPLET_ID = 12345;
const PUBLIC_IP = "1.2.3.4";

function makeDroplet(status: "new" | "active" = "active") {
  return {
    id: DROPLET_ID,
    name: `wopr-${NODE_ID}`,
    status,
    region: { slug: "nyc1", name: "New York 1" },
    size: { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, price_monthly: 48 },
    networks: { v4: [{ ip_address: PUBLIC_IP, type: "public" as const }] },
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeDoClient(overrides: Partial<DOClient> = {}): DOClient {
  return {
    createDroplet: vi.fn().mockResolvedValue(makeDroplet("new")),
    getDroplet: vi.fn().mockResolvedValue(makeDroplet("active")),
    deleteDroplet: vi.fn().mockResolvedValue(undefined),
    listRegions: vi.fn().mockResolvedValue([]),
    listSizes: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DOClient;
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
  let doClient: DOClient;

  beforeEach(() => {
    doClient = makeDoClient();
    vi.clearAllMocks();
  });

  describe("provision", () => {
    it("inserts placeholder, calls DO API, and returns result", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      const result = await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(doClient.createDroplet).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "nyc1",
          size: "s-4vcpu-8gb",
          image: "ubuntu-24-04-x64",
          ssh_keys: [123],
          tags: ["wopr-node"],
        }),
      );
      expect(nodeRepo.insertProvisioning).toHaveBeenCalled();
      expect(result.host).toBe(PUBLIC_IP);
      expect(result.dropletId).toBe(DROPLET_ID);
      expect(result.region).toBe("nyc1");
      expect(result.size).toBe("s-4vcpu-8gb");
      expect(result.monthlyCostCents).toBe(4800);
    });

    it("auto-generates nodeId when name not provided", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      const result = await provisioner.provision();

      expect(result.nodeId).toMatch(/^node-[a-f0-9]{8}$/);
    });

    it("uses provided name", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      const result = await provisioner.provision({ name: "my-custom-node" });

      expect(result.nodeId).toBe("my-custom-node");
    });

    it("uses default region and size when not provided", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, doClient, {
        sshKeyId: 123,
        defaultRegion: "sfo3",
        defaultSize: "s-2vcpu-4gb",
      });

      await provisioner.provision();

      expect(doClient.createDroplet).toHaveBeenCalledWith(
        expect.objectContaining({ region: "sfo3", size: "s-2vcpu-4gb" }),
      );
    });

    it("generates per-node secret hash and stores it in the initial insert", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(nodeRepo.insertProvisioning).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA-256 hex
        }),
      );
    });

    it("injects WOPR_NODE_SECRET into cloud-init user_data", async () => {
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      await provisioner.provision({ region: "nyc1", size: "s-4vcpu-8gb" });

      expect(doClient.createDroplet).toHaveBeenCalledWith(
        expect.objectContaining({
          user_data: expect.stringContaining("WOPR_NODE_SECRET="),
        }),
      );
    });

    it("marks node as failed on DO API error", async () => {
      const failingClient = makeDoClient({
        createDroplet: vi.fn().mockRejectedValue(new DOApiError(422, "Invalid region")),
      });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, failingClient, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("422");

      expect(nodeRepo.markFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("422"));
    });

    it("throws NodeProvisioningError when no public IP assigned", async () => {
      const noIpDroplet = {
        ...makeDroplet("active"),
        networks: { v4: [] }, // no IPs
      };
      const clientNoIp = makeDoClient({
        getDroplet: vi.fn().mockResolvedValue(noIpDroplet),
      });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, clientNoIp, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("No public IP");
    });
  });

  describe("destroy", () => {
    it("deletes DO droplet and removes node from DB when drained", async () => {
      const drained = { id: NODE_ID, drainStatus: "drained", usedMb: 0, dropletId: String(DROPLET_ID) };
      const nodeRepo = makeNodeRepo(drained);
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      await provisioner.destroy(NODE_ID);

      expect(doClient.deleteDroplet).toHaveBeenCalledWith(DROPLET_ID);
      expect(nodeRepo.delete).toHaveBeenCalledWith(NODE_ID);
    });

    it("deletes node from DB when usedMb is 0 even without drainStatus", async () => {
      const empty = { id: NODE_ID, drainStatus: null, usedMb: 0, dropletId: null };
      const nodeRepo = makeNodeRepo(empty);
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      await provisioner.destroy(NODE_ID);

      expect(doClient.deleteDroplet).not.toHaveBeenCalled(); // no dropletId
      expect(nodeRepo.delete).toHaveBeenCalledWith(NODE_ID);
    });

    it("throws when node not found", async () => {
      const nodeRepo = makeNodeRepo(undefined);
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      await expect(provisioner.destroy("nonexistent")).rejects.toThrow("not found");
    });

    it("throws when node has bots and is not drained", async () => {
      const active = { id: NODE_ID, drainStatus: null, usedMb: 500, dropletId: String(DROPLET_ID) };
      const nodeRepo = makeNodeRepo(active);
      const provisioner = new NodeProvisioner(nodeRepo, doClient, { sshKeyId: 123 });

      await expect(provisioner.destroy(NODE_ID)).rejects.toThrow("must be drained");
    });
  });

  describe("listRegions and listSizes", () => {
    it("delegates to DOClient.listRegions", async () => {
      const regions = [{ slug: "nyc1", name: "New York 1", available: true, sizes: [] }];
      const client = makeDoClient({ listRegions: vi.fn().mockResolvedValue(regions) });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, client, { sshKeyId: 123 });

      const result = await provisioner.listRegions();

      expect(result).toEqual(regions);
    });

    it("delegates to DOClient.listSizes", async () => {
      const sizes = [
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
      ];
      const client = makeDoClient({ listSizes: vi.fn().mockResolvedValue(sizes) });
      const nodeRepo = makeNodeRepo();
      const provisioner = new NodeProvisioner(nodeRepo, client, { sshKeyId: 123 });

      const result = await provisioner.listSizes();

      expect(result).toEqual(sizes);
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
