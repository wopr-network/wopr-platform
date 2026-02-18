import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConnectionManager } from "../fleet/node-connection-manager.js";
import type { RestoreLogStore } from "./restore-log-store.js";
import { RestoreService } from "./restore-service.js";
import type { SpacesClient } from "./spaces-client.js";

function createMockSpaces(): SpacesClient {
  return {
    list: vi.fn().mockResolvedValue([]),
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeMany: vi.fn().mockResolvedValue(undefined),
  } as unknown as SpacesClient;
}

function createMockNodeConnections(): NodeConnectionManager {
  return {
    sendCommand: vi.fn().mockResolvedValue({ id: "cmd-1", type: "command_result", command: "bot.inspect", success: true }),
  } as unknown as NodeConnectionManager;
}

function createMockRestoreLog(): RestoreLogStore {
  return {
    record: vi.fn().mockReturnValue({
      id: "log-entry-1",
      tenant: "tenant_abc",
      snapshotKey: "snap1",
      preRestoreKey: null,
      restoredAt: Math.floor(Date.now() / 1000),
      restoredBy: "admin-1",
      reason: null,
    }),
    listForTenant: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  } as unknown as RestoreLogStore;
}

describe("RestoreService", () => {
  let service: RestoreService;
  let mockSpaces: ReturnType<typeof createMockSpaces>;
  let mockNodeConns: ReturnType<typeof createMockNodeConnections>;
  let mockRestoreLog: ReturnType<typeof createMockRestoreLog>;

  beforeEach(() => {
    mockSpaces = createMockSpaces();
    mockNodeConns = createMockNodeConnections();
    mockRestoreLog = createMockRestoreLog();

    service = new RestoreService({
      spaces: mockSpaces,
      nodeConnections: mockNodeConns,
      restoreLog: mockRestoreLog,
      backupDir: "/backups",
    });
  });

  describe("listSnapshots", () => {
    it("lists snapshots filtered to tenant, newest first", async () => {
      vi.mocked(mockSpaces.list).mockImplementation(async (prefix: string) => {
        if (prefix === "nightly/") {
          return [
            { date: "2026-02-14T03:00:00Z", size: 10485760, path: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz" },
            { date: "2026-02-13T03:00:00Z", size: 9437184, path: "nightly/node-1/tenant_abc/tenant_abc_20260213.tar.gz" },
            { date: "2026-02-14T03:00:00Z", size: 5242880, path: "nightly/node-1/tenant_xyz/tenant_xyz_20260214.tar.gz" },
          ];
        }
        if (prefix === "latest/tenant_abc/") {
          return [
            { date: "2026-02-14T09:00:00Z", size: 11534336, path: "latest/tenant_abc/latest.tar.gz" },
          ];
        }
        return [];
      });

      const snapshots = await service.listSnapshots("abc");
      expect(snapshots).toHaveLength(3); // 2 nightly + 1 latest, xyz excluded
      expect(snapshots[0].key).toBe("latest/tenant_abc/latest.tar.gz"); // newest first
    });
  });

  describe("restore", () => {
    it("executes full restore flow and logs result", async () => {
      const result = await service.restore({
        tenantId: "abc",
        nodeId: "node-1",
        snapshotKey: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
        restoredBy: "admin-user-1",
        reason: "Rollback to stable",
      });

      expect(result.success).toBe(true);
      expect(result.restoreLogId).toBe("log-entry-1");
      expect(result.downtimeMs).toBeGreaterThanOrEqual(0);

      // Verify the command sequence: 7 calls total
      const calls = vi.mocked(mockNodeConns.sendCommand).mock.calls;
      expect(calls).toHaveLength(7);
      expect(calls[0][1].type).toBe("bot.export");
      expect(calls[1][1].type).toBe("backup.upload");
      expect(calls[2][1].type).toBe("bot.stop");
      expect(calls[3][1].type).toBe("bot.remove");
      expect(calls[4][1].type).toBe("backup.download");
      expect(calls[5][1].type).toBe("bot.import");
      expect(calls[6][1].type).toBe("bot.inspect");

      // Verify restore log was recorded
      expect(mockRestoreLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "abc",
          snapshotKey: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
          restoredBy: "admin-user-1",
          reason: "Rollback to stable",
        }),
      );
    });

    it("logs failure and returns error on command failure", async () => {
      vi.mocked(mockNodeConns.sendCommand).mockRejectedValueOnce(new Error("Container export failed"));

      const result = await service.restore({
        tenantId: "abc",
        nodeId: "node-1",
        snapshotKey: "snap1",
        restoredBy: "admin-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Container export failed");
      expect(mockRestoreLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          preRestoreKey: null,
          reason: "FAILED: Container export failed",
        }),
      );
    });
  });
});
