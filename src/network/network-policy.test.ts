import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkPolicy } from "./network-policy.js";
import { TenantNetworkManager } from "./tenant-network.js";
import { PLATFORM_NETWORK_NAME, TENANT_NETWORK_PREFIX } from "./types.js";

// Mock the TenantNetworkManager methods via the Docker mock
function mockDocker() {
  return {
    createNetwork: vi.fn(),
    listNetworks: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn(),
  };
}

function mockNetwork(id: string, name: string, containers: Record<string, unknown> = {}) {
  return {
    id,
    inspect: vi.fn().mockResolvedValue({
      Id: id,
      Name: name,
      Created: "2026-01-01T00:00:00Z",
      Containers: containers,
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe("NetworkPolicy", () => {
  let docker: ReturnType<typeof mockDocker>;
  let policy: NetworkPolicy;

  beforeEach(() => {
    docker = mockDocker();
    policy = new NetworkPolicy(docker as unknown as Docker);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("prepareForContainer", () => {
    it("creates tenant network and returns network mode", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.createNetwork.mockResolvedValue(net);

      const networkMode = await policy.prepareForContainer("user-123");

      expect(networkMode).toBe(`${TENANT_NETWORK_PREFIX}user-123`);
      expect(docker.createNetwork).toHaveBeenCalled();
    });

    it("reuses existing tenant network", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      const networkMode = await policy.prepareForContainer("user-123");

      expect(networkMode).toBe(`${TENANT_NETWORK_PREFIX}user-123`);
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });
  });

  describe("cleanupAfterRemoval", () => {
    it("removes network when no containers remain", async () => {
      // getContainerCount returns 0 (network exists but empty)
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, {});
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      await policy.cleanupAfterRemoval("user-123");

      expect(net.remove).toHaveBeenCalled();
    });

    it("keeps network when containers still exist", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, { "c-1": {} });
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      await policy.cleanupAfterRemoval("user-123");

      expect(net.remove).not.toHaveBeenCalled();
    });

    it("handles case where network already removed", async () => {
      docker.listNetworks.mockResolvedValue([]);

      // Should not throw — count returns 0, remove is a no-op
      await policy.cleanupAfterRemoval("user-123");
    });

    it("does not throw when concurrent removal races", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, {});
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);
      // Simulate the network being removed by another process between
      // getContainerCount (returns 0) and removeTenantNetwork
      net.inspect
        .mockResolvedValueOnce({ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123`, Containers: {} }) // getContainerCount
        .mockRejectedValueOnce(new Error("network not found")); // removeTenantNetwork inspect

      // Should not throw — race condition is handled gracefully
      await policy.cleanupAfterRemoval("user-123");
    });
  });

  describe("isIsolated", () => {
    it("returns true when tenant has a dedicated network", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      const isolated = await policy.isIsolated("user-123");

      expect(isolated).toBe(true);
    });

    it("returns false when tenant has no network", async () => {
      docker.listNetworks.mockResolvedValue([]);

      const isolated = await policy.isIsolated("user-123");

      expect(isolated).toBe(false);
    });
  });

  describe("ensurePlatformNetwork", () => {
    it("creates platform network", async () => {
      const net = mockNetwork("mgmt-1", PLATFORM_NETWORK_NAME);
      docker.createNetwork.mockResolvedValue(net);

      const id = await policy.ensurePlatformNetwork();

      expect(id).toBe("mgmt-1");
    });
  });

  describe("static helpers", () => {
    it("getNetworkMode returns tenant network name", () => {
      expect(NetworkPolicy.getNetworkMode("user-123")).toBe(`${TENANT_NETWORK_PREFIX}user-123`);
    });

    it("getPlatformNetworkName returns platform network name", () => {
      expect(NetworkPolicy.getPlatformNetworkName()).toBe(PLATFORM_NETWORK_NAME);
    });
  });

  describe("networks accessor", () => {
    it("exposes the underlying TenantNetworkManager", () => {
      expect(policy.networks).toBeInstanceOf(TenantNetworkManager);
    });
  });
});
