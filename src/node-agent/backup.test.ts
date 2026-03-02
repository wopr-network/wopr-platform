import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.execFile before importing backup.ts
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, "", "");
  }),
}));

import { BackupManager, HotBackupScheduler } from "./backup.js";
import type { DockerManager } from "./docker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDockerManager(overrides?: Partial<DockerManager>): DockerManager {
  return {
    docker: {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ SizeRw: 1024 }),
      }),
    },
    listTenantContainers: vi.fn().mockResolvedValue([
      { Id: "abc123", Names: ["/tenant_bot1"], State: "running" },
      { Id: "def456", Names: ["/tenant_bot2"], State: "running" },
    ]),
    exportBot: vi.fn().mockResolvedValue("/backups/tenant_bot1.tar.gz"),
    ...overrides,
  } as unknown as DockerManager;
}

// ---------------------------------------------------------------------------
// BackupManager
// ---------------------------------------------------------------------------

describe("BackupManager", () => {
  let dm: DockerManager;
  let bm: BackupManager;

  beforeEach(() => {
    vi.clearAllMocks();
    dm = mockDockerManager();
    bm = new BackupManager(dm, "/backups", "wopr-backups");
  });

  describe("upload", () => {
    it("calls s3cmd put with correct local and S3 paths", async () => {
      const { execFile } = await import("node:child_process");
      await bm.upload("tenant_bot1.tar.gz");

      expect(execFile).toHaveBeenCalledWith(
        "s3cmd",
        ["put", "/backups/tenant_bot1.tar.gz", "s3://wopr-backups/tenant_bot1.tar.gz"],
        expect.any(Function),
      );
    });

    it("safely handles path-traversal attempts by stripping to basename", async () => {
      const { execFile } = await import("node:child_process");
      // basename("../../etc/passwd") === "passwd" — no traversal escapes
      await bm.upload("../../etc/passwd");
      expect(execFile).toHaveBeenCalledWith(
        "s3cmd",
        ["put", "/backups/passwd", "s3://wopr-backups/passwd"],
        expect.any(Function),
      );
    });

    it("strips directory components from filename", async () => {
      const { execFile } = await import("node:child_process");
      await bm.upload("/some/dir/backup.tar.gz");

      expect(execFile).toHaveBeenCalledWith(
        "s3cmd",
        ["put", "/backups/backup.tar.gz", "s3://wopr-backups/backup.tar.gz"],
        expect.any(Function),
      );
    });
  });

  describe("download", () => {
    it("calls s3cmd get with correct S3 and local paths", async () => {
      const { execFile } = await import("node:child_process");
      await bm.download("tenant_bot1.tar.gz");

      expect(execFile).toHaveBeenCalledWith(
        "s3cmd",
        ["get", "s3://wopr-backups/tenant_bot1.tar.gz", "/backups/tenant_bot1.tar.gz"],
        expect.any(Function),
      );
    });

    it("safely handles path-traversal attempts by stripping to basename", async () => {
      const { execFile } = await import("node:child_process");
      // basename("../../../etc/shadow") === "shadow" — no traversal escapes
      await bm.download("../../../etc/shadow");
      expect(execFile).toHaveBeenCalledWith(
        "s3cmd",
        ["get", "s3://wopr-backups/shadow", "/backups/shadow"],
        expect.any(Function),
      );
    });
  });

  describe("runNightly", () => {
    it("exports and uploads all tenant containers", async () => {
      const { execFile } = await import("node:child_process");
      const result = await bm.runNightly();

      expect(dm.listTenantContainers).toHaveBeenCalled();
      expect(dm.exportBot).toHaveBeenCalledTimes(2);
      expect(dm.exportBot).toHaveBeenCalledWith("tenant_bot1", "/backups");
      expect(dm.exportBot).toHaveBeenCalledWith("tenant_bot2", "/backups");
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(result.exported).toEqual(["tenant_bot1", "tenant_bot2"]);
      expect(result.failed).toEqual([]);
    });

    it("continues on failure and reports failed containers", async () => {
      (dm.exportBot as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("/backups/tenant_bot1.tar.gz")
        .mockRejectedValueOnce(new Error("Docker export failed"));

      const result = await bm.runNightly();

      expect(result.exported).toEqual(["tenant_bot1"]);
      expect(result.failed).toEqual(["tenant_bot2"]);
    });

    it("handles empty container list", async () => {
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await bm.runNightly();

      expect(result.exported).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it("skips containers with no name", async () => {
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Id: "abc", Names: [], State: "running" },
      ]);
      const result = await bm.runNightly();
      expect(result.exported).toEqual([]);
      expect(result.failed).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// HotBackupScheduler
// ---------------------------------------------------------------------------

describe("HotBackupScheduler", () => {
  let dm: DockerManager;
  let scheduler: HotBackupScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    dm = mockDockerManager();
    scheduler = new HotBackupScheduler(dm, "/backups", "wopr-backups");
  });

  describe("shouldBackup", () => {
    it("returns changed=true when SizeRw differs from last known", async () => {
      const result = await scheduler.shouldBackup("abc123");
      // First call: lastKnownSize is -1 (default), SizeRw is 1024 → changed
      expect(result.changed).toBe(true);
      expect(result.sizeRw).toBe(1024);
    });

    it("returns changed=true and sizeRw=0 when inspect fails", async () => {
      (dm.docker.getContainer as ReturnType<typeof vi.fn>).mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error("container gone")),
      });

      const result = await scheduler.shouldBackup("missing-id");
      expect(result.changed).toBe(true);
      expect(result.sizeRw).toBe(0);
    });

    it("returns changed=true on first call even when SizeRw is 0 (default is -1)", async () => {
      (dm.docker.getContainer as ReturnType<typeof vi.fn>).mockReturnValue({
        inspect: vi.fn().mockResolvedValue({}), // no SizeRw → defaults to 0
      });

      const result = await scheduler.shouldBackup("xyz");
      // First call: lastKnownSize is -1 by default, 0 !== -1 → changed
      expect(result.changed).toBe(true);
      expect(result.sizeRw).toBe(0);
    });

    it("returns changed=false when SizeRw matches last known", async () => {
      // Use a fresh scheduler and prime lastKnownSize by running a successful hot backup
      const inspect = vi.fn().mockResolvedValue({ SizeRw: 512 });
      (dm.docker.getContainer as ReturnType<typeof vi.fn>).mockReturnValue({ inspect });
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Id: "ctr1", Names: ["/tenant_x"], State: "running" },
      ]);
      (dm.exportBot as ReturnType<typeof vi.fn>).mockResolvedValue("/backups/tenant_x.tar.gz");

      // First run primes the lastKnownSize
      await scheduler.runHotBackup();

      // Now check directly — same SizeRw → not changed
      const result = await scheduler.shouldBackup("ctr1");
      expect(result.changed).toBe(false);
      expect(result.sizeRw).toBe(512);
    });
  });

  describe("runHotBackup", () => {
    it("backs up all containers on first run (all new)", async () => {
      const result = await scheduler.runHotBackup();

      expect(dm.exportBot).toHaveBeenCalledTimes(2);
      expect(result.backed_up).toEqual(["tenant_bot1", "tenant_bot2"]);
      expect(result.skipped).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it("skips containers on second run when SizeRw unchanged", async () => {
      // First run: prime lastKnownSize
      await scheduler.runHotBackup();
      vi.clearAllMocks();

      // Second run setup — same containers, same SizeRw
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Id: "abc123", Names: ["/tenant_bot1"], State: "running" },
        { Id: "def456", Names: ["/tenant_bot2"], State: "running" },
      ]);
      (dm.docker.getContainer as ReturnType<typeof vi.fn>).mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ SizeRw: 1024 }),
      });
      (dm.exportBot as ReturnType<typeof vi.fn>).mockResolvedValue("/backups/x.tar.gz");

      const result = await scheduler.runHotBackup();
      expect(result.skipped).toEqual(["tenant_bot1", "tenant_bot2"]);
      expect(result.backed_up).toEqual([]);
      expect(dm.exportBot).not.toHaveBeenCalled();
    });

    it("records failed containers and continues", async () => {
      (dm.exportBot as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("/backups/tenant_bot1.tar.gz")
        .mockRejectedValueOnce(new Error("export failed"));

      const result = await scheduler.runHotBackup();

      expect(result.backed_up).toEqual(["tenant_bot1"]);
      expect(result.failed).toEqual(["tenant_bot2"]);
    });

    it("does not update lastKnownSize on export failure", async () => {
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Id: "abc123", Names: ["/tenant_bot1"], State: "running" },
      ]);
      (dm.docker.getContainer as ReturnType<typeof vi.fn>).mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ SizeRw: 100 }),
      });
      (dm.exportBot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

      await scheduler.runHotBackup();
      vi.clearAllMocks();

      // Second run: lastKnownSize was NOT updated (failure), so it should retry
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Id: "abc123", Names: ["/tenant_bot1"], State: "running" },
      ]);
      (dm.docker.getContainer as ReturnType<typeof vi.fn>).mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ SizeRw: 100 }),
      });
      (dm.exportBot as ReturnType<typeof vi.fn>).mockResolvedValue("/backups/tenant_bot1.tar.gz");

      const result = await scheduler.runHotBackup();
      expect(result.backed_up).toEqual(["tenant_bot1"]);
    });

    it("skips containers with no name or no id", async () => {
      (dm.listTenantContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Id: "", Names: ["/tenant_bot1"], State: "running" }, // no id
        { Id: "def456", Names: [], State: "running" }, // no name
      ]);

      const result = await scheduler.runHotBackup();
      expect(result.backed_up).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });

  describe("start / stop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("runs an immediate backup on start", () => {
      const runSpy = vi.spyOn(scheduler, "runHotBackup").mockResolvedValue({
        backed_up: [],
        skipped: [],
        failed: [],
      });

      scheduler.start();
      expect(runSpy).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it("does not double-start (second start is no-op)", () => {
      const runSpy = vi.spyOn(scheduler, "runHotBackup").mockResolvedValue({
        backed_up: [],
        skipped: [],
        failed: [],
      });

      scheduler.start();
      scheduler.start(); // second call is a no-op
      expect(runSpy).toHaveBeenCalledTimes(1); // only from first start
      scheduler.stop();
    });

    it("stop clears the timer (idempotent)", () => {
      vi.spyOn(scheduler, "runHotBackup").mockResolvedValue({
        backed_up: [],
        skipped: [],
        failed: [],
      });

      scheduler.start();
      scheduler.stop();
      expect(() => scheduler.stop()).not.toThrow(); // idempotent
    });

    it("fires backup at 6-hour intervals", () => {
      const runSpy = vi.spyOn(scheduler, "runHotBackup").mockResolvedValue({
        backed_up: [],
        skipped: [],
        failed: [],
      });

      scheduler.start();
      expect(runSpy).toHaveBeenCalledTimes(1); // immediate

      vi.advanceTimersByTime(6 * 60 * 60 * 1000);
      expect(runSpy).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(6 * 60 * 60 * 1000);
      expect(runSpy).toHaveBeenCalledTimes(3);

      scheduler.stop();
    });
  });
});
