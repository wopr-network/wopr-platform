import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupVerifier } from "./backup-verifier.js";
import type { SpacesClient } from "./spaces-client.js";

vi.mock("../config/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const TEST_DIR = "/tmp/backup-verifier-test";

function makeSpacesClient(opts: {
  list?: () => Promise<Array<{ path: string; size: number; date: string }>>;
  download?: (remote: string, local: string) => Promise<void>;
}): SpacesClient {
  return {
    list: opts.list ?? vi.fn().mockResolvedValue([]),
    download: opts.download ?? vi.fn().mockResolvedValue(undefined),
    upload: vi.fn(),
    remove: vi.fn(),
    removeMany: vi.fn(),
  } as unknown as SpacesClient;
}

/** Write a valid gzip file to localPath with the given content. */
async function writeValidGzip(localPath: string, content?: string): Promise<void> {
  // Generate enough data to exceed MIN_VALID_SIZE_BYTES (512 bytes) after compression
  const data = content ?? "x".repeat(2048);
  await mkdir(join(localPath, ".."), { recursive: true });
  const src = Readable.from([Buffer.from(data)]);
  const gz = createGzip();
  const dest = createWriteStream(localPath);
  await pipeline(src, gz, dest);
}

/** Write an invalid (non-gzip) file. */
async function writeInvalidFile(localPath: string): Promise<void> {
  await mkdir(join(localPath, ".."), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(localPath, Buffer.alloc(600, 0x00));
}

describe("BackupVerifier", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns empty report when prefix list fails", async () => {
    const spaces = makeSpacesClient({
      list: async () => {
        throw new Error("network error");
      },
    });
    const verifier = new BackupVerifier({ spaces, tempDir: TEST_DIR });
    const report = await verifier.verify("nightly/");
    expect(report.totalChecked).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
  });

  it("returns empty report when no backups exist", async () => {
    const spaces = makeSpacesClient({ list: async () => [] });
    const verifier = new BackupVerifier({ spaces, tempDir: TEST_DIR });
    const report = await verifier.verify("nightly/");
    expect(report.totalChecked).toBe(0);
  });

  it("passes a valid gzip backup", async () => {
    const backupPath = join(TEST_DIR, "valid.tar.gz");
    await writeValidGzip(backupPath);

    const spaces = makeSpacesClient({
      list: async () => [{ path: "nightly/node1/c1/c1_20260101.tar.gz", size: 5000, date: "2026-01-01" }],
      download: async (_remote, local) => {
        const { copyFile } = await import("node:fs/promises");
        await copyFile(backupPath, local);
      },
    });

    const verifier = new BackupVerifier({ spaces, tempDir: TEST_DIR });
    const report = await verifier.verify("nightly/");

    expect(report.totalChecked).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0].valid).toBe(true);
  });

  it("fails an invalid (non-gzip) backup", async () => {
    const badPath = join(TEST_DIR, "bad.tar.gz");
    await writeInvalidFile(badPath);

    const spaces = makeSpacesClient({
      list: async () => [{ path: "nightly/node1/c1/c1_20260101.tar.gz", size: 600, date: "2026-01-01" }],
      download: async (_remote, local) => {
        const { copyFile } = await import("node:fs/promises");
        await copyFile(badPath, local);
      },
    });

    const verifier = new BackupVerifier({ spaces, tempDir: TEST_DIR });
    const report = await verifier.verify("nightly/");

    expect(report.totalChecked).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.results[0].valid).toBe(false);
    expect(report.results[0].error).toBeTruthy();
  });

  it("respects the limit parameter", async () => {
    const listItems = Array.from({ length: 20 }, (_, i) => ({
      path: `nightly/n/c/c_202601${String(i + 1).padStart(2, "0")}.tar.gz`,
      size: 1000,
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    }));

    const downloaded: string[] = [];
    const spaces = makeSpacesClient({
      list: async () => listItems,
      download: async (remote, _local) => {
        downloaded.push(remote);
        throw new Error("simulated download error");
      },
    });

    const verifier = new BackupVerifier({ spaces, tempDir: TEST_DIR });
    await verifier.verify("nightly/", 5);

    expect(downloaded.length).toBe(5);
  });
});
