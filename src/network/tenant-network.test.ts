import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidTenantIdError,
  NetworkInUseError,
  NetworkNotFoundError,
  TenantNetworkManager,
} from "./tenant-network.js";
import { NETWORK_LABELS, PLATFORM_NETWORK_NAME, TENANT_NETWORK_PREFIX } from "./types.js";

// --- Mock helpers ---

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

function mockDocker() {
  return {
    createNetwork: vi.fn(),
    listNetworks: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn(),
  };
}

describe("TenantNetworkManager", () => {
  let docker: ReturnType<typeof mockDocker>;
  let manager: TenantNetworkManager;

  beforeEach(() => {
    docker = mockDocker();
    manager = new TenantNetworkManager(docker as unknown as Docker);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("networkNameFor", () => {
    it("returns prefixed network name", () => {
      expect(TenantNetworkManager.networkNameFor("user-123")).toBe(`${TENANT_NETWORK_PREFIX}user-123`);
    });

    it("sanitizes special characters in tenantId", () => {
      expect(TenantNetworkManager.networkNameFor("user 123")).toBe(`${TENANT_NETWORK_PREFIX}user-123`);
      expect(TenantNetworkManager.networkNameFor("user@foo!bar")).toBe(`${TENANT_NETWORK_PREFIX}user-foo-bar`);
    });

    it("preserves valid characters: alphanumeric, underscore, dot, hyphen", () => {
      expect(TenantNetworkManager.networkNameFor("user_1.test-2")).toBe(`${TENANT_NETWORK_PREFIX}user_1.test-2`);
    });

    it("throws InvalidTenantIdError for empty string", () => {
      expect(() => TenantNetworkManager.networkNameFor("")).toThrow(InvalidTenantIdError);
    });

    it("sanitizes unicode and special characters to hyphens", () => {
      // "!!!" becomes "---" — valid because the prefix provides the leading alphanumeric
      expect(TenantNetworkManager.networkNameFor("!!!")).toBe(`${TENANT_NETWORK_PREFIX}---`);
      expect(TenantNetworkManager.networkNameFor("user\u00e9")).toBe(`${TENANT_NETWORK_PREFIX}user-`);
    });
  });

  describe("ensureTenantNetwork", () => {
    it("creates a new tenant network when none exists", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.createNetwork.mockResolvedValue(net);
      docker.listNetworks.mockResolvedValue([]);

      const result = await manager.ensureTenantNetwork({ tenantId: "user-123" });

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: `${TENANT_NETWORK_PREFIX}user-123`,
          Driver: "bridge",
          Internal: false,
          Labels: expect.objectContaining({
            [NETWORK_LABELS.managed]: "true",
            [NETWORK_LABELS.tenantId]: "user-123",
            [NETWORK_LABELS.networkType]: "tenant",
          }),
          Options: expect.objectContaining({
            "com.docker.network.bridge.enable_icc": "true",
          }),
        }),
      );
      expect(result.tenantId).toBe("user-123");
      expect(result.networkName).toBe(`${TENANT_NETWORK_PREFIX}user-123`);
      expect(result.containerCount).toBe(0);
    });

    it("returns existing network when one already exists", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, { "container-1": {} });
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      const result = await manager.ensureTenantNetwork({ tenantId: "user-123" });

      expect(docker.createNetwork).not.toHaveBeenCalled();
      expect(result.networkId).toBe("net-1");
      expect(result.containerCount).toBe(1);
    });

    it("disables ICC when enableIcc is false", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.createNetwork.mockResolvedValue(net);
      docker.listNetworks.mockResolvedValue([]);

      await manager.ensureTenantNetwork({ tenantId: "user-123", enableIcc: false });

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Options: expect.objectContaining({
            "com.docker.network.bridge.enable_icc": "false",
          }),
        }),
      );
    });

    it("handles 409 conflict by returning existing network", async () => {
      const conflictError = new Error("Conflict") as Error & { statusCode: number };
      conflictError.statusCode = 409;
      docker.createNetwork.mockRejectedValue(conflictError);
      docker.listNetworks
        .mockResolvedValueOnce([]) // first findNetwork call returns empty
        .mockResolvedValueOnce([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]); // retry findNetwork
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.getNetwork.mockReturnValue(net);

      const result = await manager.ensureTenantNetwork({ tenantId: "user-123" });

      expect(result.networkId).toBe("net-1");
    });

    it("rethrows non-409 errors from createNetwork", async () => {
      const otherError = new Error("Internal Server Error") as Error & { statusCode: number };
      otherError.statusCode = 500;
      docker.createNetwork.mockRejectedValue(otherError);
      docker.listNetworks.mockResolvedValue([]);

      await expect(manager.ensureTenantNetwork({ tenantId: "user-123" })).rejects.toThrow("Internal Server Error");
    });

    it("uses custom subnet when provided", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.createNetwork.mockResolvedValue(net);
      docker.listNetworks.mockResolvedValue([]);

      await manager.ensureTenantNetwork({ tenantId: "user-123", subnet: "172.20.0.0/16" });

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          IPAM: {
            Driver: "default",
            Config: [{ Subnet: "172.20.0.0/16" }],
          },
        }),
      );
    });
  });

  describe("removeTenantNetwork", () => {
    it("removes an empty tenant network", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      await manager.removeTenantNetwork("user-123");

      expect(net.remove).toHaveBeenCalled();
    });

    it("does nothing if network does not exist", async () => {
      docker.listNetworks.mockResolvedValue([]);

      // Should not throw
      await manager.removeTenantNetwork("user-123");
    });

    it("throws NetworkInUseError when containers are attached", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, {
        "container-1": {},
        "container-2": {},
      });
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      await expect(manager.removeTenantNetwork("user-123")).rejects.toThrow(NetworkInUseError);
    });
  });

  describe("getTenantNetwork", () => {
    it("returns tenant network info when it exists", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, { "container-1": {} });
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      const result = await manager.getTenantNetwork("user-123");

      expect(result).not.toBeNull();
      expect(result?.networkId).toBe("net-1");
      expect(result?.tenantId).toBe("user-123");
      expect(result?.containerCount).toBe(1);
    });

    it("returns null when network does not exist", async () => {
      docker.listNetworks.mockResolvedValue([]);

      const result = await manager.getTenantNetwork("user-123");

      expect(result).toBeNull();
    });
  });

  describe("listTenantNetworks", () => {
    it("returns all managed tenant networks", async () => {
      const net1 = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-1`);
      const net2 = mockNetwork("net-2", `${TENANT_NETWORK_PREFIX}user-2`, { "c-1": {} });

      docker.listNetworks.mockResolvedValue([
        { Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-1`, Labels: { [NETWORK_LABELS.tenantId]: "user-1" } },
        { Id: "net-2", Name: `${TENANT_NETWORK_PREFIX}user-2`, Labels: { [NETWORK_LABELS.tenantId]: "user-2" } },
      ]);
      docker.getNetwork.mockImplementation((id: string) => {
        if (id === "net-1") return net1;
        return net2;
      });

      const result = await manager.listTenantNetworks();

      expect(result).toHaveLength(2);
      expect(result[0].tenantId).toBe("user-1");
      expect(result[1].tenantId).toBe("user-2");
      expect(result[1].containerCount).toBe(1);
    });

    it("returns empty array when no tenant networks exist", async () => {
      docker.listNetworks.mockResolvedValue([]);

      const result = await manager.listTenantNetworks();

      expect(result).toHaveLength(0);
    });
  });

  describe("ensurePlatformNetwork", () => {
    it("creates platform management network when it does not exist", async () => {
      const net = mockNetwork("mgmt-1", PLATFORM_NETWORK_NAME);
      docker.createNetwork.mockResolvedValue(net);
      docker.listNetworks.mockResolvedValue([]);

      const id = await manager.ensurePlatformNetwork();

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: PLATFORM_NETWORK_NAME,
          Driver: "bridge",
          Labels: expect.objectContaining({
            [NETWORK_LABELS.managed]: "true",
            [NETWORK_LABELS.networkType]: "platform",
          }),
        }),
      );
      expect(id).toBe("mgmt-1");
    });

    it("returns existing platform network ID", async () => {
      const net = mockNetwork("mgmt-1", PLATFORM_NETWORK_NAME);
      docker.listNetworks.mockResolvedValue([{ Id: "mgmt-1", Name: PLATFORM_NETWORK_NAME }]);
      docker.getNetwork.mockReturnValue(net);

      const id = await manager.ensurePlatformNetwork();

      expect(docker.createNetwork).not.toHaveBeenCalled();
      expect(id).toBe("mgmt-1");
    });
  });

  describe("connectContainer", () => {
    it("connects a container to the tenant network", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      await manager.connectContainer("user-123", "container-abc");

      expect(net.connect).toHaveBeenCalledWith({ Container: "container-abc" });
    });

    it("throws NetworkNotFoundError when network does not exist", async () => {
      docker.listNetworks.mockResolvedValue([]);

      await expect(manager.connectContainer("user-123", "container-abc")).rejects.toThrow(NetworkNotFoundError);
    });
  });

  describe("disconnectContainer", () => {
    it("disconnects a container from the tenant network", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`);
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      await manager.disconnectContainer("user-123", "container-abc");

      expect(net.disconnect).toHaveBeenCalledWith({ Container: "container-abc" });
    });

    it("does not throw when network does not exist", async () => {
      docker.listNetworks.mockResolvedValue([]);

      // Should not throw — graceful handling
      await manager.disconnectContainer("user-123", "container-abc");
    });
  });

  describe("getContainerCount", () => {
    it("returns the number of attached containers", async () => {
      const net = mockNetwork("net-1", `${TENANT_NETWORK_PREFIX}user-123`, {
        "c-1": {},
        "c-2": {},
        "c-3": {},
      });
      docker.listNetworks.mockResolvedValue([{ Id: "net-1", Name: `${TENANT_NETWORK_PREFIX}user-123` }]);
      docker.getNetwork.mockReturnValue(net);

      const count = await manager.getContainerCount("user-123");

      expect(count).toBe(3);
    });

    it("returns 0 when network does not exist", async () => {
      docker.listNetworks.mockResolvedValue([]);

      const count = await manager.getContainerCount("user-123");

      expect(count).toBe(0);
    });
  });
});
