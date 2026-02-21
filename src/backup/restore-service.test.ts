import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../config/logger.js";
import type { INodeCommandBus } from "../fleet/node-command-bus.js";
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

function createMockCommandBus(): INodeCommandBus {
  return {
    send: vi.fn().mockResolvedValue({ id: "cmd-1", type: "command_result", command: "bot.inspect", success: true }),
  } as unknown as INodeCommandBus;
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
  let mockCommandBus: ReturnType<typeof createMockCommandBus>;
  let mockRestoreLog: ReturnType<typeof createMockRestoreLog>;

  beforeEach(() => {
    mockSpaces = createMockSpaces();
    mockCommandBus = createMockCommandBus();
    mockRestoreLog = createMockRestoreLog();

    service = new RestoreService({
      spaces: mockSpaces,
      commandBus: mockCommandBus,
      restoreLog: mockRestoreLog,
    });
  });

  describe("listSnapshots", () => {
    it("lists snapshots filtered to tenant, newest first", async () => {
      vi.mocked(mockSpaces.list).mockImplementation(async (prefix: string) => {
        if (prefix === "nightly/") {
          return [
            {
              date: "2026-02-14T03:00:00Z",
              size: 10485760,
              path: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
            },
            {
              date: "2026-02-13T03:00:00Z",
              size: 9437184,
              path: "nightly/node-1/tenant_abc/tenant_abc_20260213.tar.gz",
            },
            {
              date: "2026-02-14T03:00:00Z",
              size: 5242880,
              path: "nightly/node-1/tenant_xyz/tenant_xyz_20260214.tar.gz",
            },
          ];
        }
        if (prefix === "latest/tenant_abc/") {
          return [{ date: "2026-02-14T09:00:00Z", size: 11534336, path: "latest/tenant_abc/latest.tar.gz" }];
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
      const calls = vi.mocked(mockCommandBus.send).mock.calls;
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
      vi.mocked(mockCommandBus.send).mockRejectedValueOnce(new Error("Container export failed"));

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

    it("attempts recovery from pre-restore snapshot when bot.import fails after container removal", async () => {
      // First 4 calls succeed (export, upload, stop, remove), 5th (download target) succeeds,
      // 6th (bot.import) fails — container is already gone.
      vi.mocked(mockCommandBus.send)
        .mockResolvedValueOnce({ id: "cmd-1", type: "command_result", command: "bot.export", success: true }) // 1. export
        .mockResolvedValueOnce({ id: "cmd-2", type: "command_result", command: "backup.upload", success: true }) // 2. upload
        .mockResolvedValueOnce({ id: "cmd-3", type: "command_result", command: "bot.stop", success: true }) // 3. stop
        .mockResolvedValueOnce({ id: "cmd-4", type: "command_result", command: "bot.remove", success: true }) // 4. remove (point of no return)
        .mockResolvedValueOnce({ id: "cmd-5", type: "command_result", command: "backup.download", success: true }) // 5. download target
        .mockRejectedValueOnce(new Error("Import failed")) // 6. bot.import fails
        .mockResolvedValueOnce({ id: "cmd-7", type: "command_result", command: "backup.download", success: true }) // 7. recovery download
        .mockResolvedValueOnce({ id: "cmd-8", type: "command_result", command: "bot.import", success: true }); // 8. recovery import

      const result = await service.restore({
        tenantId: "abc",
        nodeId: "node-1",
        snapshotKey: "nightly/node-1/tenant_abc/snap.tar.gz",
        restoredBy: "admin-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Import failed");

      // Should have attempted recovery: backup.download + bot.import from pre-restore key
      const calls = vi.mocked(mockCommandBus.send).mock.calls;
      expect(calls).toHaveLength(8);
      expect(calls[6][1].type).toBe("backup.download"); // recovery download
      expect(calls[7][1].type).toBe("bot.import"); // recovery import
    });

    it("logs CRITICAL alert when recovery from pre-restore snapshot also fails", async () => {
      const errorSpy = vi.spyOn(logger, "error");

      vi.mocked(mockCommandBus.send)
        .mockResolvedValueOnce({ id: "cmd-1", type: "command_result", command: "bot.export", success: true })
        .mockResolvedValueOnce({ id: "cmd-2", type: "command_result", command: "backup.upload", success: true })
        .mockResolvedValueOnce({ id: "cmd-3", type: "command_result", command: "bot.stop", success: true })
        .mockResolvedValueOnce({ id: "cmd-4", type: "command_result", command: "bot.remove", success: true })
        .mockRejectedValueOnce(new Error("Download failed")) // step 5 fails after remove
        .mockRejectedValueOnce(new Error("Recovery also failed")); // recovery download also fails

      const result = await service.restore({
        tenantId: "abc",
        nodeId: "node-1",
        snapshotKey: "nightly/node-1/tenant_abc/snap.tar.gz",
        restoredBy: "admin-1",
      });

      expect(result.success).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("CRITICAL"),
        expect.objectContaining({ err: "Recovery also failed" }),
      );
    });
  });
});
