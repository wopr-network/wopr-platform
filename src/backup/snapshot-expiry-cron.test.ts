import { describe, expect, it, vi } from "vitest";
import { runSnapshotExpiryCron } from "./snapshot-expiry-cron.js";
import type { SnapshotManager } from "./snapshot-manager.js";
import type { Snapshot } from "./types.js";

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-1",
    tenant: "tenant-a",
    instanceId: "bot-1",
    userId: "user-1",
    name: null,
    type: "on-demand",
    s3Key: null,
    sizeMb: 10,
    sizeBytes: null,
    nodeId: null,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() - 1000, // expired 1 second ago
    deletedAt: null,
    trigger: "manual",
    plugins: [],
    configHash: "",
    storagePath: "/data/snapshots/snap-1.tar.gz",
    ...overrides,
  };
}

describe("runSnapshotExpiryCron", () => {
  it("expires snapshots past expiresAt", async () => {
    const expiredSnap = makeSnapshot({ id: "s1", expiresAt: Date.now() - 1000 });
    const manager = {
      listExpired: vi.fn().mockReturnValue([expiredSnap]),
      hardDelete: vi.fn().mockResolvedValue(true),
    } as unknown as SnapshotManager;

    const result = await runSnapshotExpiryCron(manager);

    expect(result.expired).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(manager.hardDelete).toHaveBeenCalledWith("s1");
  });

  it("does not expire snapshots not yet expired", async () => {
    const manager = {
      listExpired: vi.fn().mockReturnValue([]), // none expired
      hardDelete: vi.fn(),
    } as unknown as SnapshotManager;

    const result = await runSnapshotExpiryCron(manager);

    expect(result.expired).toBe(0);
    expect(manager.hardDelete).not.toHaveBeenCalled();
  });

  it("handles hardDelete errors gracefully", async () => {
    const expiredSnap = makeSnapshot({ id: "s1" });
    const manager = {
      listExpired: vi.fn().mockReturnValue([expiredSnap]),
      hardDelete: vi.fn().mockRejectedValue(new Error("disk full")),
    } as unknown as SnapshotManager;

    const result = await runSnapshotExpiryCron(manager);

    expect(result.expired).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("disk full");
  });

  it("processes multiple expired snapshots", async () => {
    const snaps = [makeSnapshot({ id: "s1" }), makeSnapshot({ id: "s2" }), makeSnapshot({ id: "s3" })];
    const manager = {
      listExpired: vi.fn().mockReturnValue(snaps),
      hardDelete: vi.fn().mockResolvedValue(true),
    } as unknown as SnapshotManager;

    const result = await runSnapshotExpiryCron(manager);

    expect(result.expired).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(manager.hardDelete).toHaveBeenCalledTimes(3);
  });

  it("continues processing after one failure", async () => {
    const snaps = [makeSnapshot({ id: "s1" }), makeSnapshot({ id: "s2" })];
    const manager = {
      listExpired: vi.fn().mockReturnValue(snaps),
      hardDelete: vi.fn().mockRejectedValueOnce(new Error("s1 failed")).mockResolvedValueOnce(true),
    } as unknown as SnapshotManager;

    const result = await runSnapshotExpiryCron(manager);

    expect(result.expired).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
