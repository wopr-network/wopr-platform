import { describe, expect, it, vi } from "vitest";
import type { MeterEmitter } from "../monetization/metering/emitter.js";
import type { SnapshotManager } from "./snapshot-manager.js";
import { runStorageMeteringCron } from "./storage-metering-cron.js";
import type { Snapshot } from "./types.js";
import { STORAGE_CHARGE_PER_GB_MONTH, STORAGE_COST_PER_GB_MONTH } from "./types.js";

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-1",
    tenant: "tenant-a",
    instanceId: "bot-1",
    userId: "user-1",
    name: null,
    type: "on-demand",
    s3Key: null,
    sizeMb: 1024, // 1GB
    sizeBytes: 1024 * 1024 * 1024,
    nodeId: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    deletedAt: null,
    trigger: "manual",
    plugins: [],
    configHash: "",
    storagePath: "/data/snapshots/snap-1.tar.gz",
    ...overrides,
  };
}

describe("runStorageMeteringCron", () => {
  it("runs with no snapshots, returns zero counts", async () => {
    const manager = { listAllActive: vi.fn().mockReturnValue([]) } as unknown as SnapshotManager;
    const meterEmitter = { emit: vi.fn() } as unknown as MeterEmitter;

    const result = await runStorageMeteringCron({ manager, meterEmitter });

    expect(result.tenantsProcessed).toBe(0);
    expect(result.snapshotsCounted).toBe(0);
    expect(result.totalSizeGb).toBe(0);
    expect(result.totalCharge).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(meterEmitter.emit).not.toHaveBeenCalled();
  });

  it("groups snapshots by tenant and emits one event per tenant", async () => {
    const snaps: Snapshot[] = [
      makeSnapshot({ id: "s1", tenant: "tenant-a", sizeBytes: 1024 * 1024 * 1024 }), // 1GB
      makeSnapshot({ id: "s2", tenant: "tenant-a", sizeBytes: 512 * 1024 * 1024 }), // 0.5GB
      makeSnapshot({ id: "s3", tenant: "tenant-b", sizeBytes: 256 * 1024 * 1024 }), // 0.25GB
    ];
    const manager = { listAllActive: vi.fn().mockReturnValue(snaps) } as unknown as SnapshotManager;
    const meterEmitter = { emit: vi.fn() } as unknown as MeterEmitter;

    const result = await runStorageMeteringCron({ manager, meterEmitter });

    expect(result.tenantsProcessed).toBe(2);
    expect(result.snapshotsCounted).toBe(3);
    // Two emit calls, one per tenant
    expect(meterEmitter.emit).toHaveBeenCalledTimes(2);

    const calls = (meterEmitter.emit as ReturnType<typeof vi.fn>).mock.calls;
    const tenants = calls.map((c: unknown[]) => (c[0] as { tenant: string }).tenant).sort();
    expect(tenants).toEqual(["tenant-a", "tenant-b"]);
  });

  it("calculates correct cost/charge per GB", async () => {
    const snaps: Snapshot[] = [
      makeSnapshot({ id: "s1", tenant: "tenant-a", sizeBytes: 1024 * 1024 * 1024 }), // exactly 1GB
    ];
    const manager = { listAllActive: vi.fn().mockReturnValue(snaps) } as unknown as SnapshotManager;
    const meterEmitter = { emit: vi.fn() } as unknown as MeterEmitter;

    await runStorageMeteringCron({ manager, meterEmitter });

    const emitCall = (meterEmitter.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(emitCall.cost).toBeCloseTo(STORAGE_COST_PER_GB_MONTH, 5);
    expect(emitCall.charge).toBeCloseTo(STORAGE_CHARGE_PER_GB_MONTH, 5);
    expect(emitCall.capability).toBe("storage");
    expect(emitCall.provider).toBe("do-spaces");
  });

  it("handles meter emit errors gracefully", async () => {
    const snaps: Snapshot[] = [makeSnapshot({ id: "s1", tenant: "tenant-a", sizeBytes: 1024 * 1024 * 1024 })];
    const manager = { listAllActive: vi.fn().mockReturnValue(snaps) } as unknown as SnapshotManager;
    const meterEmitter = {
      emit: vi.fn().mockImplementation(() => {
        throw new Error("emit failed");
      }),
    } as unknown as MeterEmitter;

    const result = await runStorageMeteringCron({ manager, meterEmitter });

    expect(result.tenantsProcessed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("emit failed");
  });

  it("uses sizeBytes when available, falls back to sizeMb", async () => {
    const snaps: Snapshot[] = [
      // sizeBytes is null, should fall back to sizeMb
      makeSnapshot({ id: "s1", tenant: "tenant-a", sizeBytes: null, sizeMb: 1024 }),
    ];
    const manager = { listAllActive: vi.fn().mockReturnValue(snaps) } as unknown as SnapshotManager;
    const meterEmitter = { emit: vi.fn() } as unknown as MeterEmitter;

    const result = await runStorageMeteringCron({ manager, meterEmitter });

    expect(result.snapshotsCounted).toBe(1);
    expect(result.totalSizeGb).toBeGreaterThan(0);
  });
});
