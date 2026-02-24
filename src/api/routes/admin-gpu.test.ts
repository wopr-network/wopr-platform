import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock services before importing route
vi.mock("../../fleet/services.js", () => ({
  getGpuNodeRepository: vi.fn(),
  getGpuNodeProvisioner: vi.fn(),
  getDOClient: vi.fn(),
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
}));
vi.mock("../../auth/index.js", () => ({
  buildTokenMetadataMap: vi.fn().mockReturnValue(new Map()),
  scopedBearerAuthWithTenant: vi.fn().mockReturnValue(async (c: any, next: any) => {
    c.set("user", { id: "test-admin" });
    await next();
  }),
}));

import type { GpuNode } from "../../fleet/repository-types.js";
import { getAdminAuditLog, getDOClient, getGpuNodeProvisioner, getGpuNodeRepository } from "../../fleet/services.js";
import { adminGpuRoutes } from "./admin-gpu.js";

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

describe("admin-gpu routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAdminAuditLog as ReturnType<typeof vi.fn>).mockReturnValue({ log: vi.fn() });
  });

  describe("GET /", () => {
    it("should list all GPU nodes", async () => {
      const nodes = [makeGpuNode()];
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ list: () => nodes });

      const res = await adminGpuRoutes.request("/");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.nodes).toHaveLength(1);
      expect(body.count).toBe(1);
    });

    it("should return empty list when no GPU nodes", async () => {
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ list: () => [] });

      const res = await adminGpuRoutes.request("/");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.nodes).toHaveLength(0);
      expect(body.count).toBe(0);
    });
  });

  describe("POST /", () => {
    it("should provision a GPU node", async () => {
      const result = {
        nodeId: "gpu-new",
        host: "10.0.0.2",
        dropletId: 999,
        region: "nyc1",
        size: "gpu-h100x1-80gb",
        monthlyCostCents: 250000,
      };
      (getGpuNodeProvisioner as ReturnType<typeof vi.fn>).mockReturnValue({
        provision: vi.fn().mockResolvedValue(result),
      });

      const res = await adminGpuRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "nyc1", size: "gpu-h100x1-80gb" }),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.node.nodeId).toBe("gpu-new");
    });

    it("should return 503 when DO_API_TOKEN is missing", async () => {
      (getGpuNodeProvisioner as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DO_API_TOKEN environment variable is required");
      });

      const res = await adminGpuRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
    });

    it("should return 500 when provisioning fails with generic error", async () => {
      (getGpuNodeProvisioner as ReturnType<typeof vi.fn>).mockReturnValue({
        provision: vi.fn().mockRejectedValue(new Error("network timeout")),
      });

      const res = await adminGpuRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "nyc1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("network timeout");
    });

    it("should return 500 with Unknown error when provisioning fails with non-Error", async () => {
      (getGpuNodeProvisioner as ReturnType<typeof vi.fn>).mockReturnValue({
        provision: vi.fn().mockRejectedValue("string error"),
      });

      const res = await adminGpuRoutes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe("Unknown error");
    });
  });

  describe("GET /regions", () => {
    it("should return available regions", async () => {
      const regions = [{ slug: "nyc1", name: "New York 1", available: true, sizes: [] }];
      (getDOClient as ReturnType<typeof vi.fn>).mockReturnValue({
        listRegions: vi.fn().mockResolvedValue(regions),
      });

      const res = await adminGpuRoutes.request("/regions");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.regions).toHaveLength(1);
    });

    it("should return 503 when DO_API_TOKEN is missing for regions", async () => {
      (getDOClient as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DO_API_TOKEN environment variable is required");
      });

      const res = await adminGpuRoutes.request("/regions");
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
    });

    it("should return 500 when regions request fails with generic error", async () => {
      (getDOClient as ReturnType<typeof vi.fn>).mockReturnValue({
        listRegions: vi.fn().mockRejectedValue(new Error("DO API down")),
      });

      const res = await adminGpuRoutes.request("/regions");
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("DO API down");
    });
  });

  describe("GET /sizes", () => {
    it("should return available sizes", async () => {
      const sizes = [
        {
          slug: "gpu-h100x1-80gb",
          memory: 81920,
          vcpus: 8,
          disk: 320,
          price_monthly: 2500,
          available: true,
          regions: ["nyc1"],
          description: "GPU H100",
        },
      ];
      (getDOClient as ReturnType<typeof vi.fn>).mockReturnValue({
        listSizes: vi.fn().mockResolvedValue(sizes),
      });

      const res = await adminGpuRoutes.request("/sizes");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.sizes).toHaveLength(1);
    });

    it("should return 503 when DO_API_TOKEN is missing for sizes", async () => {
      (getDOClient as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DO_API_TOKEN environment variable is required");
      });

      const res = await adminGpuRoutes.request("/sizes");
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
    });

    it("should return 500 when sizes request fails with generic error", async () => {
      (getDOClient as ReturnType<typeof vi.fn>).mockReturnValue({
        listSizes: vi.fn().mockRejectedValue(new Error("DO API unavailable")),
      });

      const res = await adminGpuRoutes.request("/sizes");
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("DO API unavailable");
    });
  });

  describe("GET /:nodeId", () => {
    it("should return a GPU node", async () => {
      const node = makeGpuNode();
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });

      const res = await adminGpuRoutes.request("/gpu-test-1");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.node.id).toBe("gpu-test-1");
    });

    it("should return 404 for unknown node", async () => {
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => null });

      const res = await adminGpuRoutes.request("/nonexistent");
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  describe("DELETE /:nodeId", () => {
    it("should destroy a GPU node", async () => {
      const node = makeGpuNode({ status: "active" });
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });
      (getGpuNodeProvisioner as ReturnType<typeof vi.fn>).mockReturnValue({
        destroy: vi.fn().mockResolvedValue(undefined),
      });

      const res = await adminGpuRoutes.request("/gpu-test-1", { method: "DELETE" });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("should return 404 when node not found on destroy", async () => {
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => null });

      const res = await adminGpuRoutes.request("/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("should return 409 when node is provisioning", async () => {
      const node = makeGpuNode({ status: "provisioning" });
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });

      const res = await adminGpuRoutes.request("/gpu-test-1", { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    it("should return 409 when node is bootstrapping", async () => {
      const node = makeGpuNode({ status: "bootstrapping" });
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });

      const res = await adminGpuRoutes.request("/gpu-test-1", { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    it("should return 500 when destroy throws an error", async () => {
      const node = makeGpuNode({ status: "active" });
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });
      (getGpuNodeProvisioner as ReturnType<typeof vi.fn>).mockReturnValue({
        destroy: vi.fn().mockRejectedValue(new Error("DO delete failed")),
      });

      const res = await adminGpuRoutes.request("/gpu-test-1", { method: "DELETE" });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("DO delete failed");
    });
  });

  describe("POST /:nodeId/reboot", () => {
    it("should reboot a GPU node", async () => {
      const node = makeGpuNode();
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });
      (getDOClient as ReturnType<typeof vi.fn>).mockReturnValue({
        rebootDroplet: vi.fn().mockResolvedValue(undefined),
      });

      const res = await adminGpuRoutes.request("/gpu-test-1/reboot", { method: "POST" });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain("gpu-test-1");
    });

    it("should return 404 for unknown node", async () => {
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => null });

      const res = await adminGpuRoutes.request("/nonexistent/reboot", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("should return 400 when node has no droplet", async () => {
      const node = makeGpuNode({ dropletId: null });
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });

      const res = await adminGpuRoutes.request("/gpu-test-1/reboot", { method: "POST" });
      expect(res.status).toBe(400);
    });

    it("should return 500 when reboot throws an error", async () => {
      const node = makeGpuNode();
      (getGpuNodeRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getById: () => node });
      (getDOClient as ReturnType<typeof vi.fn>).mockReturnValue({
        rebootDroplet: vi.fn().mockRejectedValue(new Error("reboot API failed")),
      });

      const res = await adminGpuRoutes.request("/gpu-test-1/reboot", { method: "POST" });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("reboot API failed");
    });
  });
});
