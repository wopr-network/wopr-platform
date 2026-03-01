import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock services before importing routes
vi.mock("../../fleet/services.js", () => ({
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
  getMigrationOrchestrator: vi.fn(),
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
import { getAdminAuditLog, getMigrationOrchestrator } from "../../fleet/services.js";
import { adminMigrationRoutes } from "./admin-migration.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAdminAuditLog).mockReturnValue({ log: vi.fn() } as unknown as AdminAuditLog);
});

describe("adminMigrationRoutes", () => {
  // POST /:botId

  describe("POST /:botId", () => {
    it("migrates bot to target node and returns success", async () => {
      vi.mocked(getMigrationOrchestrator).mockReturnValue({
        migrate: vi.fn().mockResolvedValue({
          success: true,
          sourceNodeId: "node-1",
          targetNodeId: "node-2",
          downtimeMs: 1500,
        }),
        // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
      } as any);

      const res = await adminMigrationRoutes.request("/bot-123", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNodeId: "node-2" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.result.targetNodeId).toBe("node-2");
    });

    it("auto-selects target node when targetNodeId is omitted", async () => {
      vi.mocked(getMigrationOrchestrator).mockReturnValue({
        migrate: vi.fn().mockResolvedValue({
          success: true,
          sourceNodeId: "node-1",
          targetNodeId: "node-auto",
          downtimeMs: 800,
        }),
        // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
      } as any);

      const res = await adminMigrationRoutes.request("/bot-456", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("handles missing body (auto-select)", async () => {
      vi.mocked(getMigrationOrchestrator).mockReturnValue({
        migrate: vi.fn().mockResolvedValue({
          success: true,
          sourceNodeId: "node-1",
          targetNodeId: "node-auto",
          downtimeMs: 1200,
        }),
        // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
      } as any);

      const res = await adminMigrationRoutes.request("/bot-789", {
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("returns 400 when migration fails", async () => {
      vi.mocked(getMigrationOrchestrator).mockReturnValue({
        migrate: vi.fn().mockResolvedValue({
          success: false,
          error: "No suitable target node available",
        }),
        // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
      } as any);

      const res = await adminMigrationRoutes.request("/bot-fail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNodeId: "node-full" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it("returns 500 on unexpected error", async () => {
      vi.mocked(getMigrationOrchestrator).mockReturnValue({
        migrate: vi.fn().mockRejectedValue(new Error("orchestrator crashed")),
        // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
      } as any);

      const res = await adminMigrationRoutes.request("/bot-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNodeId: "node-2" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("orchestrator crashed");
    });

    it("logs audit entry on success", async () => {
      const mockLog = vi.fn();
      vi.mocked(getAdminAuditLog).mockReturnValue({ log: mockLog } as unknown as AdminAuditLog);
      vi.mocked(getMigrationOrchestrator).mockReturnValue({
        migrate: vi.fn().mockResolvedValue({
          success: true,
          sourceNodeId: "node-1",
          targetNodeId: "node-2",
          downtimeMs: 1000,
        }),
        // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
      } as any);

      await adminMigrationRoutes.request("/bot-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNodeId: "node-2" }),
      });

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "bot.migrate",
          category: "config",
          details: expect.objectContaining({ botId: "bot-audit" }),
        }),
      );
    });
  });
});
