import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock services before importing routes
vi.mock("../../fleet/services.js", () => ({
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
  getBotInstanceRepo: vi.fn(),
  getNodeDrainer: vi.fn(),
  getNodeRepo: vi.fn(),
  getRecoveryOrchestrator: vi.fn(),
  getRecoveryRepo: vi.fn(),
  getMigrationOrchestrator: vi.fn(),
  getCommandBus: vi.fn(),
}));

vi.mock("../../auth/index.js", () => ({
  buildTokenMetadataMap: vi.fn().mockReturnValue(new Map()),
  // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
  scopedBearerAuthWithTenant: vi.fn().mockReturnValue(async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: "test-admin" });
    await next();
  }),
}));

import type { AdminAuditLog } from "../../admin/audit-log.js";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import type { NodeDrainer } from "../../fleet/node-drainer.js";
import type { INodeRepository } from "../../fleet/node-repository.js";
import type { RecoveryOrchestrator } from "../../fleet/recovery-orchestrator.js";
import type { IRecoveryRepository } from "../../fleet/recovery-repository.js";
import {
  getAdminAuditLog,
  getBotInstanceRepo,
  getNodeDrainer,
  getNodeRepo,
  getRecoveryOrchestrator,
  getRecoveryRepo,
} from "../../fleet/services.js";
import { adminNodeRoutes, adminRecoveryRoutes } from "./admin-recovery.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAdminAuditLog).mockReturnValue({ log: vi.fn() } as unknown as AdminAuditLog);
});

describe("adminRecoveryRoutes", () => {
  // GET / — list recovery events

  describe("GET /", () => {
    it("returns recovery events list", async () => {
      const mockEvents = [
        {
          id: "evt-1",
          nodeId: "node-1",
          trigger: "watchdog",
          status: "completed",
          startedAt: 1000,
          completedAt: 2000,
          totalTenants: 3,
          recovered: 3,
          failed: 0,
        },
      ];
      vi.mocked(getRecoveryRepo).mockReturnValue({
        listEvents: vi.fn().mockResolvedValue(mockEvents),
<<<<<<< HEAD
      } as unknown as IRecoveryRepository);

      const res = await adminRecoveryRoutes.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
      expect(body.events[0].id).toBe("evt-1");
    });

    it("accepts limit query param", async () => {
      vi.mocked(getRecoveryRepo).mockReturnValue({
        listEvents: vi.fn().mockResolvedValue([]),
<<<<<<< HEAD
      } as unknown as IRecoveryRepository);

      const res = await adminRecoveryRoutes.request("/?limit=10");
      expect(res.status).toBe(200);
    });

    it("accepts status filter query param", async () => {
      vi.mocked(getRecoveryRepo).mockReturnValue({
        listEvents: vi.fn().mockResolvedValue([]),
<<<<<<< HEAD
      } as unknown as IRecoveryRepository);

      const res = await adminRecoveryRoutes.request("/?status=completed");
      expect(res.status).toBe(200);
    });

    it("ignores invalid status filter", async () => {
      vi.mocked(getRecoveryRepo).mockReturnValue({
        listEvents: vi.fn().mockResolvedValue([]),
<<<<<<< HEAD
      } as unknown as IRecoveryRepository);

      const res = await adminRecoveryRoutes.request("/?status=invalid");
      expect(res.status).toBe(200);
    });
  });

  // GET /:eventId — get recovery event details

  describe("GET /:eventId", () => {
    it("returns event details", async () => {
      const mockEvent = {
        id: "evt-1",
        nodeId: "node-1",
        status: "completed",
        startedAt: 1000,
      };
      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        getEventDetails: vi.fn().mockResolvedValue({
          event: mockEvent,
          items: [],
        }),
<<<<<<< HEAD
      } as unknown as RecoveryOrchestrator);

      const res = await adminRecoveryRoutes.request("/evt-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.event.id).toBe("evt-1");
    });

    it("returns 404 for unknown event", async () => {
      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        getEventDetails: vi.fn().mockResolvedValue({ event: null, items: [] }),
<<<<<<< HEAD
      } as unknown as RecoveryOrchestrator);

      const res = await adminRecoveryRoutes.request("/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  // POST /:eventId/retry

  describe("POST /:eventId/retry", () => {
    it("retries waiting tenants and returns report", async () => {
      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        retryWaiting: vi.fn().mockResolvedValue({ retried: 2, failed: 0 }),
<<<<<<< HEAD
      } as unknown as RecoveryOrchestrator);

      const res = await adminRecoveryRoutes.request("/evt-1/retry", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.report).toEqual({ retried: 2, failed: 0 });
    });

    it("returns 500 on error", async () => {
      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        retryWaiting: vi.fn().mockRejectedValue(new Error("orchestrator failed")),
<<<<<<< HEAD
      } as unknown as RecoveryOrchestrator);

      const res = await adminRecoveryRoutes.request("/evt-1/retry", {
        method: "POST",
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("orchestrator failed");
    });
  });
});

describe("adminNodeRoutes", () => {
  // GET / — list nodes

  describe("GET /", () => {
    it("returns nodes list", async () => {
      const mockNodes = [
        {
          id: "node-1",
          host: "10.0.0.1",
          status: "active",
          currentLoad: 5,
          maxLoad: 50,
          region: "nyc1",
          size: "s-2vcpu-4gb",
          dropletId: null,
          monthlyCostCents: 2400,
          lastHeartbeatAt: null,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];
      vi.mocked(getNodeRepo).mockReturnValue({
        list: vi.fn().mockResolvedValue(mockNodes),
<<<<<<< HEAD
      } as unknown as INodeRepository);

      const res = await adminNodeRoutes.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
    });
  });

  // GET /:nodeId

  describe("GET /:nodeId", () => {
    it("returns node details", async () => {
      const mockNode = {
        id: "node-1",
        host: "10.0.0.1",
        status: "active",
        currentLoad: 5,
        maxLoad: 50,
        region: "nyc1",
        size: "s-2vcpu-4gb",
        dropletId: null,
        monthlyCostCents: 2400,
        lastHeartbeatAt: null,
        createdAt: 1000,
        updatedAt: 1000,
      };
      vi.mocked(getNodeRepo).mockReturnValue({
        getById: vi.fn().mockResolvedValue(mockNode),
<<<<<<< HEAD
      } as unknown as INodeRepository);
      vi.mocked(getBotInstanceRepo).mockReturnValue({
        listByNode: vi.fn().mockResolvedValue([]),
      } as unknown as IBotInstanceRepository);

      const res = await adminNodeRoutes.request("/node-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.node.id).toBe("node-1");
    });

    it("returns 404 for unknown node", async () => {
      vi.mocked(getNodeRepo).mockReturnValue({
        getById: vi.fn().mockResolvedValue(null),
<<<<<<< HEAD
      } as unknown as INodeRepository);

      const res = await adminNodeRoutes.request("/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  // GET /:nodeId/tenants

  describe("GET /:nodeId/tenants", () => {
    it("returns tenants for a node", async () => {
      vi.mocked(getBotInstanceRepo).mockReturnValue({
        listByNode: vi.fn().mockResolvedValue([{ id: "bot-1", tenantId: "tenant-a", nodeId: "node-1" }]),
      } as unknown as IBotInstanceRepository);

      const res = await adminNodeRoutes.request("/node-1/tenants");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
    });
  });

  // POST /:nodeId/drain

  describe("POST /:nodeId/drain", () => {
    it("drains a node and returns result", async () => {
      vi.mocked(getNodeDrainer).mockReturnValue({
        drain: vi.fn().mockResolvedValue({ migrated: ["bot-1"], failed: [] }),
<<<<<<< HEAD
      } as unknown as NodeDrainer);

      const res = await adminNodeRoutes.request("/node-1/drain", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns failure info when some bots fail to migrate", async () => {
      vi.mocked(getNodeDrainer).mockReturnValue({
        drain: vi.fn().mockResolvedValue({ migrated: [], failed: ["bot-1"] }),
<<<<<<< HEAD
      } as unknown as NodeDrainer);

      const res = await adminNodeRoutes.request("/node-1/drain", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // success=false when there are failures
      expect(body.success).toBe(false);
    });
  });

  // POST /:nodeId/recover

  describe("POST /:nodeId/recover", () => {
    it("triggers manual recovery and returns report", async () => {
      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        triggerRecovery: vi.fn().mockResolvedValue({ recovered: 2, failed: 0 }),
        getEventDetails: vi.fn(),
        retryWaiting: vi.fn(),
<<<<<<< HEAD
      } as unknown as RecoveryOrchestrator);

      const res = await adminNodeRoutes.request("/node-1/recover", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns 500 on error", async () => {
      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        triggerRecovery: vi.fn().mockRejectedValue(new Error("recovery failed")),
        getEventDetails: vi.fn(),
        retryWaiting: vi.fn(),
<<<<<<< HEAD
      } as unknown as RecoveryOrchestrator);

      const res = await adminNodeRoutes.request("/node-1/recover", {
        method: "POST",
      });
      expect(res.status).toBe(500);
    });
  });
});
