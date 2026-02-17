import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DOClient } from "./do-client.js";
import { DOApiError } from "./do-client.js";
import { NodeProvisioner, NodeProvisioningError } from "./node-provisioner.js";

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

function makeDb(nodeRow: Record<string, unknown> | undefined = undefined) {
  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    update: vi
      .fn()
      .mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(nodeRow),
        }),
      }),
    }),
  };
}

describe("NodeProvisioner", () => {
  let doClient: DOClient;

  beforeEach(() => {
    doClient = makeDoClient();
    vi.clearAllMocks();
  });

  describe("provision", () => {
    it("inserts placeholder, calls DO API, and returns result", async () => {
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

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
      expect(db.insert).toHaveBeenCalled();
      expect(result.host).toBe(PUBLIC_IP);
      expect(result.dropletId).toBe(DROPLET_ID);
      expect(result.region).toBe("nyc1");
      expect(result.size).toBe("s-4vcpu-8gb");
      expect(result.monthlyCostCents).toBe(4800);
    });

    it("auto-generates nodeId when name not provided", async () => {
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

      const result = await provisioner.provision();

      expect(result.nodeId).toMatch(/^node-[a-f0-9]{8}$/);
    });

    it("uses provided name", async () => {
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

      const result = await provisioner.provision({ name: "my-custom-node" });

      expect(result.nodeId).toBe("my-custom-node");
    });

    it("uses default region and size when not provided", async () => {
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, doClient, {
        sshKeyId: 123,
        defaultRegion: "sfo3",
        defaultSize: "s-2vcpu-4gb",
      });

      await provisioner.provision();

      expect(doClient.createDroplet).toHaveBeenCalledWith(
        expect.objectContaining({ region: "sfo3", size: "s-2vcpu-4gb" }),
      );
    });

    it("marks node as failed on DO API error", async () => {
      const failingClient = makeDoClient({
        createDroplet: vi.fn().mockRejectedValue(new DOApiError(422, "Invalid region")),
      });
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, failingClient, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("422");

      // Should have called update to mark as failed
      expect(db.update).toHaveBeenCalled();
      const setCall = db.update.mock.results[0].value.set;
      expect(setCall).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", provisionStage: "failed" }));
    });

    it("throws NodeProvisioningError when no public IP assigned", async () => {
      const noIpDroplet = {
        ...makeDroplet("active"),
        networks: { v4: [] }, // no IPs
      };
      const clientNoIp = makeDoClient({
        getDroplet: vi.fn().mockResolvedValue(noIpDroplet),
      });
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, clientNoIp, { sshKeyId: 123 });

      await expect(provisioner.provision()).rejects.toThrow("No public IP");
    });
  });

  describe("destroy", () => {
    it("deletes DO droplet and removes node from DB when drained", async () => {
      const drained = { id: NODE_ID, drainStatus: "drained", usedMb: 0, dropletId: String(DROPLET_ID) };
      const db = makeDb(drained);
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

      await provisioner.destroy(NODE_ID);

      expect(doClient.deleteDroplet).toHaveBeenCalledWith(DROPLET_ID);
      expect(db.delete).toHaveBeenCalled();
    });

    it("deletes node from DB when usedMb is 0 even without drainStatus", async () => {
      const empty = { id: NODE_ID, drainStatus: null, usedMb: 0, dropletId: null };
      const db = makeDb(empty);
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

      await provisioner.destroy(NODE_ID);

      expect(doClient.deleteDroplet).not.toHaveBeenCalled(); // no dropletId
      expect(db.delete).toHaveBeenCalled();
    });

    it("throws when node not found", async () => {
      const db = makeDb(undefined);
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

      await expect(provisioner.destroy("nonexistent")).rejects.toThrow("not found");
    });

    it("throws when node has bots and is not drained", async () => {
      const active = { id: NODE_ID, drainStatus: null, usedMb: 500, dropletId: String(DROPLET_ID) };
      const db = makeDb(active);
      const provisioner = new NodeProvisioner(db as never, doClient, { sshKeyId: 123 });

      await expect(provisioner.destroy(NODE_ID)).rejects.toThrow("must be drained");
    });
  });

  describe("listRegions and listSizes", () => {
    it("delegates to DOClient.listRegions", async () => {
      const regions = [{ slug: "nyc1", name: "New York 1", available: true, sizes: [] }];
      const client = makeDoClient({ listRegions: vi.fn().mockResolvedValue(regions) });
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, client, { sshKeyId: 123 });

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
      const db = makeDb();
      const provisioner = new NodeProvisioner(db as never, client, { sshKeyId: 123 });

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
