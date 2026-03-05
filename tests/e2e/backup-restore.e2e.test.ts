import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleBackupStatusRepository } from "../../src/backup/backup-status-repository.js";
import { BackupStatusStore } from "../../src/backup/backup-status-store.js";
import { BackupVerifier } from "../../src/backup/backup-verifier.js";
import { DrizzleSnapshotRepository } from "../../src/backup/snapshot-repository.js";
import { SnapshotManager, SnapshotNotFoundError } from "../../src/backup/snapshot-manager.js";
import type { DrizzleDb } from "../../src/db/index.js";
import type { SpacesClient } from "../../src/backup/spaces-client.js";
import { createTestDb } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TEST_BASE = "/tmp/e2e-backup-restore";

function makeSpacesClient(overrides?: Partial<SpacesClient>): SpacesClient {
  return {
    list: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeMany: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SpacesClient;
}

describe("E2E: Backup & Restore (snapshot → verify → restore)", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let snapshotRepo: DrizzleSnapshotRepository;
  let snapshotManager: SnapshotManager;
  let backupStatusStore: BackupStatusStore;
  let testDir: string;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    snapshotRepo = new DrizzleSnapshotRepository(db);
    const testId = randomUUID().slice(0, 8);
    testDir = join(TEST_BASE, testId);
    const snapshotDir = join(testDir, "snapshots");
    const woprHomeDir = join(testDir, "instances");
    await mkdir(snapshotDir, { recursive: true });
    await mkdir(woprHomeDir, { recursive: true });

    snapshotManager = new SnapshotManager({
      snapshotDir,
      repo: snapshotRepo,
    });

    const backupStatusRepo = new DrizzleBackupStatusRepository(db);
    backupStatusStore = new BackupStatusStore(backupStatusRepo);
  });

  afterEach(async () => {
    await pool.close();
    await rm(TEST_BASE, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Happy path: create → verify → drift → restore → verify match
  // -----------------------------------------------------------------------

  it("snapshot → verify integrity → simulate drift → restore → config matches original", async () => {
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const woprHome = join(testDir, "instances", botId);
    await mkdir(woprHome, { recursive: true });

    // 1. Create bot with config and running state
    const originalConfig = {
      name: "TestBot",
      model: "gpt-4",
      plugins: ["discord", "web"],
      temperature: 0.7,
    };
    await writeFile(join(woprHome, "config.json"), JSON.stringify(originalConfig));
    await writeFile(join(woprHome, "state.json"), JSON.stringify({ running: true, uptime: 3600 }));
    await mkdir(join(woprHome, "data"), { recursive: true });
    await writeFile(join(woprHome, "data", "memory.db"), "fake-db-content");

    const originalConfigHash = createHash("sha256")
      .update(JSON.stringify(originalConfig))
      .digest("hex");

    // 2. Create snapshot of bot state
    const snapshot = await snapshotManager.create({
      instanceId: botId,
      userId: "user-1",
      woprHomePath: woprHome,
      trigger: "manual",
      tenant: tenantId,
      name: "pre-deploy-backup",
    });

    expect(snapshot.id).toBeTruthy();
    expect(snapshot.instanceId).toBe(botId);
    expect(snapshot.configHash).toBe(originalConfigHash);
    expect(snapshot.sizeBytes).toBeGreaterThan(0);
    expect(snapshot.storagePath).toContain(".tar.gz");

    // 3. Verify snapshot integrity (backup-verifier) via mock SpacesClient
    const spaces = makeSpacesClient({
      list: vi.fn().mockResolvedValue([
        { path: `on-demand/${tenantId}/${snapshot.id}.tar.gz`, size: snapshot.sizeBytes ?? 100, date: snapshot.createdAt },
      ]),
      download: vi.fn().mockImplementation(async (_remote: string, local: string) => {
        await copyFile(snapshot.storagePath, local);
      }),
    });

    const verifier = new BackupVerifier({ spaces, tempDir: join(testDir, "verify-tmp") });
    const report = await verifier.verify("on-demand/");

    expect(report.totalChecked).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0].valid).toBe(true);

    // 4. Simulate config drift
    const driftedConfig = {
      name: "DriftedBot",
      model: "gpt-3.5-turbo",
      plugins: ["discord"],
      temperature: 1.0,
      newField: "unexpected",
    };
    await writeFile(join(woprHome, "config.json"), JSON.stringify(driftedConfig));
    await writeFile(join(woprHome, "state.json"), JSON.stringify({ running: false, uptime: 0 }));

    // Confirm drift happened
    const driftedContent = JSON.parse(await readFile(join(woprHome, "config.json"), "utf-8"));
    expect(driftedContent.name).toBe("DriftedBot");

    // 5. Restore from snapshot
    await snapshotManager.restore(snapshot.id, woprHome);

    // 6. Verify bot config matches original
    const restoredConfig = JSON.parse(await readFile(join(woprHome, "config.json"), "utf-8"));
    expect(restoredConfig).toEqual(originalConfig);

    const restoredState = JSON.parse(await readFile(join(woprHome, "state.json"), "utf-8"));
    expect(restoredState).toEqual({ running: true, uptime: 3600 });

    const restoredMemory = await readFile(join(woprHome, "data", "memory.db"), "utf-8");
    expect(restoredMemory).toBe("fake-db-content");

    // Verify configHash of restored config matches snapshot's hash
    const restoredHash = createHash("sha256")
      .update(await readFile(join(woprHome, "config.json"), "utf-8"))
      .digest("hex");
    expect(restoredHash).toBe(snapshot.configHash);
  });

  // -----------------------------------------------------------------------
  // Backup status repository tracks all operations
  // -----------------------------------------------------------------------

  it("backup status repository tracks success and failure operations", async () => {
    const containerId = `tenant_${randomUUID().slice(0, 8)}`;
    const nodeId = "node-1";

    // Record success
    await backupStatusStore.recordSuccess(containerId, nodeId, 150, "nightly/node-1/backup.tar.gz");

    const entry = await backupStatusStore.get(containerId);
    expect(entry).not.toBeNull();
    expect(entry!.containerId).toBe(containerId);
    expect(entry!.nodeId).toBe(nodeId);
    expect(entry!.lastBackupSizeMb).toBe(150);
    expect(entry!.lastBackupSuccess).toBe(true);
    expect(entry!.lastBackupError).toBeNull();
    expect(entry!.totalBackups).toBe(1);

    // Record another success — totalBackups increments
    await backupStatusStore.recordSuccess(containerId, nodeId, 160, "nightly/node-1/backup2.tar.gz");
    const updated = await backupStatusStore.get(containerId);
    expect(updated!.totalBackups).toBe(2);
    expect(updated!.lastBackupSizeMb).toBe(160);

    // Record failure — success flag flips, error captured
    await backupStatusStore.recordFailure(containerId, nodeId, "disk full");
    const failed = await backupStatusStore.get(containerId);
    expect(failed!.lastBackupSuccess).toBe(false);
    expect(failed!.lastBackupError).toBe("disk full");

    // Count and listAll
    const count = await backupStatusStore.count();
    expect(count).toBeGreaterThanOrEqual(1);

    const all = await backupStatusStore.listAll();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Edge case: Restore non-existent snapshot
  // -----------------------------------------------------------------------

  it("restore rejects with SnapshotNotFoundError for non-existent snapshot", async () => {
    await expect(
      snapshotManager.restore("non-existent-id", join(testDir, "instances", "ghost")),
    ).rejects.toThrow(SnapshotNotFoundError);
  });

  // -----------------------------------------------------------------------
  // Edge case: Multiple snapshots — restore to specific version
  // -----------------------------------------------------------------------

  it("creates multiple snapshots and restores to a specific earlier version", async () => {
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const woprHome = join(testDir, "instances", botId);
    await mkdir(woprHome, { recursive: true });

    // Version 1
    await writeFile(join(woprHome, "config.json"), JSON.stringify({ version: 1 }));
    const snap1 = await snapshotManager.create({
      instanceId: botId,
      userId: "user-1",
      woprHomePath: woprHome,
      trigger: "manual",
      name: "v1",
    });

    // Version 2
    await writeFile(join(woprHome, "config.json"), JSON.stringify({ version: 2 }));
    const snap2 = await snapshotManager.create({
      instanceId: botId,
      userId: "user-1",
      woprHomePath: woprHome,
      trigger: "manual",
      name: "v2",
    });

    // Version 3
    await writeFile(join(woprHome, "config.json"), JSON.stringify({ version: 3 }));
    await snapshotManager.create({
      instanceId: botId,
      userId: "user-1",
      woprHomePath: woprHome,
      trigger: "manual",
      name: "v3",
    });

    // List snapshots — should have 3
    const allSnaps = await snapshotManager.list(botId);
    expect(allSnaps.length).toBe(3);

    // Restore to version 1 (not latest)
    await snapshotManager.restore(snap1.id, woprHome);
    const restored = JSON.parse(await readFile(join(woprHome, "config.json"), "utf-8"));
    expect(restored.version).toBe(1);

    // Restore to version 2
    await snapshotManager.restore(snap2.id, woprHome);
    const restored2 = JSON.parse(await readFile(join(woprHome, "config.json"), "utf-8"));
    expect(restored2.version).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Edge case: Corrupted snapshot detected by verifier
  // -----------------------------------------------------------------------

  it("verifier detects corrupted snapshot (invalid gzip)", async () => {
    const corruptPath = join(testDir, "corrupt.tar.gz");
    const buf = Buffer.alloc(200, 0x00);
    buf[0] = 0x1f;
    buf[1] = 0x8b;
    buf.fill(0xaa, 2);
    await writeFile(corruptPath, buf);

    const spaces = makeSpacesClient({
      list: vi.fn().mockResolvedValue([
        { path: "nightly/node-1/c1/corrupt.tar.gz", size: 200, date: "2026-01-01" },
      ]),
      download: vi.fn().mockImplementation(async (_remote: string, local: string) => {
        await copyFile(corruptPath, local);
      }),
    });

    const verifier = new BackupVerifier({ spaces, tempDir: join(testDir, "verify-tmp") });
    const report = await verifier.verify("nightly/");

    expect(report.totalChecked).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.results[0].valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Edge case: Snapshot of deleted bot (WOPR_HOME doesn't exist)
  // -----------------------------------------------------------------------

  it("restore handles missing WOPR_HOME gracefully (creates it)", async () => {
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const woprHome = join(testDir, "instances", botId);
    await mkdir(woprHome, { recursive: true });

    await writeFile(join(woprHome, "config.json"), JSON.stringify({ ok: true }));
    const snapshot = await snapshotManager.create({
      instanceId: botId,
      userId: "user-1",
      woprHomePath: woprHome,
      trigger: "manual",
    });

    // Delete the WOPR_HOME directory entirely (simulates deleted bot)
    await rm(woprHome, { recursive: true, force: true });

    // Restore should succeed — it handles ENOENT on rename
    await snapshotManager.restore(snapshot.id, woprHome);

    const restored = JSON.parse(await readFile(join(woprHome, "config.json"), "utf-8"));
    expect(restored).toEqual({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Edge case: Stale backup detection
  // -----------------------------------------------------------------------

  it("marks backups as stale when last successful backup is >24h ago", async () => {
    const containerId = `tenant_stale_${randomUUID().slice(0, 8)}`;

    // Record a failure (no successful backup = stale)
    await backupStatusStore.recordFailure(containerId, "node-1", "timeout");

    const staleList = await backupStatusStore.listStale();
    const found = staleList.find((e) => e.containerId === containerId);
    expect(found).toBeTruthy();
    expect(found!.isStale).toBe(true);
  });
});
