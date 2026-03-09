import { describe, expect, it, vi } from "vitest";
import type { AdminNotifier } from "./admin-notifier.js";
import { CapacityPolicy, type CapacityPolicyConfig } from "./capacity-policy.js";
import type { NodeProvisioner } from "./node-provisioner.js";
import type { INodeRepository } from "./node-repository.js";
import type { Node } from "./repository-types.js";

function makeNode(overrides: Partial<Node>): Node {
  return {
    id: "node-1",
    host: "1.2.3.4",
    status: "active",
    capacityMb: 8192,
    usedMb: 0,
    agentVersion: null,
    lastHeartbeatAt: null,
    registeredAt: 0,
    updatedAt: 0,
    dropletId: null,
    region: null,
    size: null,
    monthlyCostCents: null,
    provisionStage: null,
    lastError: null,
    drainStatus: null,
    drainMigrated: null,
    drainTotal: null,
    ownerUserId: null,
    nodeSecret: null,
    label: null,
    ...overrides,
  };
}

const defaultConfig: CapacityPolicyConfig = {
  scaleUpThresholdPercent: 95,
  scaleDownThresholdPercent: 40,
  scaleDownSustainedMs: 300_000,
  scaleUpCooldownMs: 300_000,
  scaleDownCooldownMs: 600_000,
  minNodes: 1,
};

function makeMocks() {
  const nodeRepo = {
    list: vi.fn<() => Promise<Node[]>>(),
  } as unknown as INodeRepository;
  const provisioner = {
    provision: vi.fn().mockResolvedValue({
      nodeId: "node-new",
      host: "5.6.7.8",
      externalId: "ext-1",
      region: "nyc1",
      size: "s-4vcpu-8gb",
      monthlyCostCents: 4800,
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as NodeProvisioner;
  const notifier = {
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminNotifier;
  return { nodeRepo, provisioner, notifier };
}

describe("CapacityPolicy", () => {
  describe("scale up", () => {
    it("triggers provision when fleet usage exceeds scaleUpThresholdPercent", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 7800, capacityMb: 8192, status: "active" }), // ~95.2%
      ]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      expect(result.action).toBe("scale_up");
      expect(provisioner.provision).toHaveBeenCalledOnce();
    });

    it("does not scale up when usage is below threshold", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 4000, capacityMb: 8192, status: "active" }), // ~48.8%
      ]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      expect(result.action).toBe("none");
      expect(provisioner.provision).not.toHaveBeenCalled();
    });

    it("respects scale-up cooldown", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 7800, capacityMb: 8192, status: "active" }),
      ]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      await policy.evaluate(); // first scale-up
      const result = await policy.evaluate(); // second call, within cooldown

      expect(result.action).toBe("none");
      expect(result.reason).toContain("cooldown");
      expect(provisioner.provision).toHaveBeenCalledOnce();
    });
  });

  describe("scale down", () => {
    it("does not scale down immediately when usage drops below threshold", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 1000, capacityMb: 8192, status: "active" }),
        makeNode({ id: "node-2", usedMb: 500, capacityMb: 8192, status: "active" }),
      ]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      expect(result.action).toBe("none");
      expect(result.reason).toContain("sustained");
      expect(provisioner.destroy).not.toHaveBeenCalled();
    });

    it("scales down after sustained low usage exceeds scaleDownSustainedMs", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 1000, capacityMb: 8192, status: "active" }),
        makeNode({ id: "node-2", usedMb: 0, capacityMb: 8192, status: "active" }),
      ]);

      const config = { ...defaultConfig, scaleDownSustainedMs: 0 }; // immediate for test
      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, config);
      const result = await policy.evaluate();

      expect(result.action).toBe("scale_down");
      expect(result.targetNodeId).toBe("node-2"); // least loaded
      expect(provisioner.destroy).toHaveBeenCalledWith("node-2");
    });

    it("does not scale below minNodes", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 500, capacityMb: 8192, status: "active" }),
      ]);

      const config = { ...defaultConfig, scaleDownSustainedMs: 0, minNodes: 1 };
      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, config);
      const result = await policy.evaluate();

      expect(result.action).toBe("none");
      expect(result.reason).toContain("minNodes");
      expect(provisioner.destroy).not.toHaveBeenCalled();
    });

    it("targets the node with lowest usedMb and only if usedMb is 0", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 1000, capacityMb: 8192, status: "active" }),
        makeNode({ id: "node-2", usedMb: 500, capacityMb: 8192, status: "active" }),
        makeNode({ id: "node-3", usedMb: 0, capacityMb: 8192, status: "active" }),
      ]);

      const config = { ...defaultConfig, scaleDownSustainedMs: 0, minNodes: 1 };
      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, config);
      const result = await policy.evaluate();

      expect(result.action).toBe("scale_down");
      expect(result.targetNodeId).toBe("node-3");
    });

    it("does not scale down if no node has usedMb === 0", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 1000, capacityMb: 8192, status: "active" }),
        makeNode({ id: "node-2", usedMb: 500, capacityMb: 8192, status: "active" }),
      ]);

      const config = { ...defaultConfig, scaleDownSustainedMs: 0, minNodes: 1 };
      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, config);
      const result = await policy.evaluate();

      expect(result.action).toBe("none");
      expect(result.reason).toContain("no empty node");
    });
  });

  describe("fleet usage calculation", () => {
    it("excludes nodes with zero capacity from usage calculation", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 4000, capacityMb: 8192, status: "active" }), // ~48.8%
        makeNode({ id: "node-2", usedMb: 0, capacityMb: 0, status: "active" }), // excluded
      ]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      expect(result.fleetUsagePercent).toBeCloseTo(48.8, 0);
      expect(result.action).toBe("none");
    });

    it("only considers active nodes", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 7800, capacityMb: 8192, status: "active" }),
        makeNode({ id: "node-2", usedMb: 7800, capacityMb: 8192, status: "draining" }), // excluded
      ]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      // Only node-1 counts: 7800/8192 = 95.2%
      expect(result.fleetUsagePercent).toBeCloseTo(95.2, 0);
    });

    it("returns action none for empty fleet", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      expect(result.action).toBe("none");
      expect(result.fleetUsagePercent).toBe(0);
    });
  });

  describe("error handling", () => {
    it("returns action none and logs when provisioner.provision throws", async () => {
      const { nodeRepo, provisioner, notifier } = makeMocks();
      (nodeRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNode({ id: "node-1", usedMb: 7800, capacityMb: 8192, status: "active" }),
      ]);
      (provisioner.provision as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DO API down"));

      const policy = new CapacityPolicy(nodeRepo, provisioner, notifier, defaultConfig);
      const result = await policy.evaluate();

      expect(result.action).toBe("none");
      expect(result.reason).toContain("failed");
    });
  });
});
