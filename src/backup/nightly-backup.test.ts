import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatDate, NightlyBackup } from "./nightly-backup.js";

describe("formatDate", () => {
  it("formats a date as YYYYMMDD", () => {
    expect(formatDate(new Date("2026-02-14T12:00:00Z"))).toBe("20260214");
  });

  it("zero-pads month and day", () => {
    expect(formatDate(new Date("2026-01-05T00:00:00Z"))).toBe("20260105");
  });

  it("handles December 31", () => {
    expect(formatDate(new Date("2026-12-31T23:59:59Z"))).toBe("20261231");
  });
});

describe("NightlyBackup.run", () => {
  const backupDir = path.join(os.tmpdir(), "wopr-nightly-test");

  function makeDocker(containers: Array<{ Names: string[] }>, exportFn?: (name: string) => Promise<void>) {
    return {
      listTenantContainers: vi.fn().mockResolvedValue(containers),
      exportBot: exportFn ?? vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeSpaces() {
    return {
      upload: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("returns empty report when no containers exist", async () => {
    const docker = makeDocker([]);
    const spaces = makeSpaces();

    const backup = new NightlyBackup({
      docker: docker as never,
      spaces: spaces as never,
      backupDir,
      nodeId: "node-1",
    });

    const report = await backup.run();
    expect(report.nodeId).toBe("node-1");
    expect(report.results).toEqual([]);
    expect(report.exported).toEqual([]);
    expect(report.failed).toEqual([]);
  });

  it("skips containers with no name", async () => {
    const docker = makeDocker([{ Names: [] }]);
    const spaces = makeSpaces();

    const backup = new NightlyBackup({
      docker: docker as never,
      spaces: spaces as never,
      backupDir,
      nodeId: "node-1",
    });

    const report = await backup.run();
    expect(report.results).toEqual([]);
  });

  it("records success when container backup completes", async () => {
    const fs = await import("node:fs/promises");
    const containerName = "tenant-abc";
    const date = formatDate(new Date());
    const exportPath = path.join(backupDir, `${containerName}.tar.gz`);

    const docker = makeDocker([{ Names: [`/${containerName}`] }], async (_name: string) => {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(exportPath, "fake-data");
    });

    const spaces = makeSpaces();
    const backup = new NightlyBackup({
      docker: docker as never,
      spaces: spaces as never,
      backupDir,
      nodeId: "node-1",
    });

    const report = await backup.run();
    expect(report.exported).toContain(containerName);
    expect(report.failed).toEqual([]);
    expect(spaces.upload).toHaveBeenCalledOnce();
    const result = report.results[0];
    expect(result.success).toBe(true);
    expect(result.remotePath).toContain(date);
  });

  it("records failure when exportBot throws", async () => {
    const containerName = "broken-container";
    const docker = makeDocker([{ Names: [`/${containerName}`] }], async () => {
      throw new Error("docker export failed");
    });
    const spaces = makeSpaces();

    const backup = new NightlyBackup({
      docker: docker as never,
      spaces: spaces as never,
      backupDir,
      nodeId: "node-1",
    });

    const report = await backup.run();
    expect(report.failed).toContain(containerName);
    expect(report.exported).toEqual([]);
    const result = report.results[0];
    expect(result.success).toBe(false);
    expect(result.error).toContain("docker export failed");
  });

  it("strips leading slash from container name", async () => {
    const docker = makeDocker([{ Names: ["/prefixed-name"] }], async () => {
      throw new Error("intentional");
    });
    const spaces = makeSpaces();
    const backup = new NightlyBackup({
      docker: docker as never,
      spaces: spaces as never,
      backupDir,
      nodeId: "node-1",
    });

    const report = await backup.run();
    expect(report.failed).toContain("prefixed-name");
  });

  it("encrypts backup when BACKUP_ENCRYPTION_KEY is set", async () => {
    const fs = await import("node:fs/promises");
    const containerName = "tenant-enc";
    const exportPath = path.join(backupDir, `${containerName}.tar.gz`);

    const docker = makeDocker([{ Names: [`/${containerName}`] }], async (_name: string) => {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(exportPath, "fake-data-for-encryption-test");
    });

    const spaces = makeSpaces();
    const backup = new NightlyBackup({
      docker: docker as never,
      spaces: spaces as never,
      backupDir,
      nodeId: "node-1",
    });

    const originalKey = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = "test-key-test-key-test-key-32!!";
    try {
      const report = await backup.run();
      expect(report.exported).toContain(containerName);
      expect(report.failed).toEqual([]);
      // Encrypted upload path should end in .enc
      const result = report.results[0];
      expect(result.success).toBe(true);
      expect(result.remotePath).toMatch(/\.enc$/);
    } finally {
      if (originalKey === undefined) {
        delete process.env.BACKUP_ENCRYPTION_KEY;
      } else {
        process.env.BACKUP_ENCRYPTION_KEY = originalKey;
      }
    }
  });
});
