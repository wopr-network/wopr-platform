import { describe, expect, it, vi } from "vitest";
import type { CreditLedger } from "../monetization/credits/credit-ledger.js";
import type { MeterEmitter } from "../monetization/metering/emitter.js";
import {
  InsufficientCreditsError,
  OnDemandSnapshotService,
  SnapshotQuotaExceededError,
} from "./on-demand-snapshot-service.js";
import type { SnapshotManager } from "./snapshot-manager.js";
import type { Snapshot, Tier } from "./types.js";
import { SNAPSHOT_TIER_POLICIES } from "./types.js";

// ---- helpers ----------------------------------------------------------------

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-1",
    tenant: "tenant-a",
    instanceId: "bot-1",
    userId: "user-1",
    name: null,
    type: "on-demand",
    s3Key: null,
    sizeMb: 200,
    sizeBytes: 200 * 1024 * 1024,
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

// ---- mock factories ---------------------------------------------------------

function makeManager(overrides: Record<string, unknown> = {}): SnapshotManager {
  return {
    countByTenant: vi.fn().mockReturnValue(0),
    create: vi.fn().mockResolvedValue(makeSnapshot()),
    get: vi.fn().mockReturnValue(null),
    delete: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as SnapshotManager;
}

function makeMeter(): MeterEmitter {
  return { emit: vi.fn() } as unknown as MeterEmitter;
}

function makeLedger(balanceCents = 100): CreditLedger {
  return { balance: vi.fn().mockReturnValue(balanceCents) } as unknown as CreditLedger;
}

function makeService(managerOverrides: Record<string, unknown> = {}, balanceCents = 100) {
  const manager = makeManager(managerOverrides);
  const meter = makeMeter();
  const ledger = makeLedger(balanceCents);
  const service = new OnDemandSnapshotService({ manager, meterEmitter: meter, ledger });
  return { service, manager, meter, ledger };
}

// ---- tests ------------------------------------------------------------------

describe("OnDemandSnapshotService", () => {
  describe("checkQuota", () => {
    it("returns allowed when under limit", () => {
      const { service } = makeService({ countByTenant: vi.fn().mockReturnValue(0) });
      const result = service.checkQuota("tenant-a", "free");
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
      expect(result.max).toBe(SNAPSHOT_TIER_POLICIES.free.onDemandMax);
    });

    it("returns denied when at limit for free tier", () => {
      const max = SNAPSHOT_TIER_POLICIES.free.onDemandMax;
      const { service } = makeService({ countByTenant: vi.fn().mockReturnValue(max) });
      const result = service.checkQuota("tenant-a", "free");
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(max);
      expect(result.reason).toContain("limit reached");
    });

    it("returns denied when at limit for starter tier", () => {
      const max = SNAPSHOT_TIER_POLICIES.starter.onDemandMax;
      const { service } = makeService({ countByTenant: vi.fn().mockReturnValue(max) });
      const result = service.checkQuota("tenant-a", "starter");
      expect(result.allowed).toBe(false);
    });

    it("returns denied when at limit for pro tier", () => {
      const max = SNAPSHOT_TIER_POLICIES.pro.onDemandMax;
      const { service } = makeService({ countByTenant: vi.fn().mockReturnValue(max) });
      const result = service.checkQuota("tenant-a", "pro");
      expect(result.allowed).toBe(false);
    });

    it("enterprise tier allows unlimited snapshots", () => {
      const { service } = makeService({ countByTenant: vi.fn().mockReturnValue(10000) });
      const result = service.checkQuota("tenant-a", "enterprise");
      expect(result.allowed).toBe(true);
    });
  });

  describe("estimateCost", () => {
    it("calculates correctly for 200MB snapshot", () => {
      const { service } = makeService();
      const sizeBytes = 200 * 1024 * 1024; // 200MB
      const result = service.estimateCost(sizeBytes);
      // 200MB / 1024 MB per GB = ~0.195 GB * $0.05 * 100 cents = ~0.98 cents, ceil = 1 cent
      expect(result.monthlyChargeCents).toBeGreaterThanOrEqual(1);
      expect(result.monthlyCostCents).toBeGreaterThanOrEqual(0);
      // Charge must be at least as large as cost (2.5x margin)
      expect(result.monthlyChargeCents).toBeGreaterThanOrEqual(result.monthlyCostCents);
    });

    it("returns zero for zero-byte snapshot", () => {
      const { service } = makeService();
      const result = service.estimateCost(0);
      expect(result.monthlyCostCents).toBe(0);
      expect(result.monthlyChargeCents).toBe(0);
    });
  });

  describe("create", () => {
    const createParams = {
      tenant: "tenant-a",
      instanceId: "bot-1",
      userId: "user-1",
      woprHomePath: "/data/instances/bot-1",
      tier: "free" as Tier,
    };

    it("creates snapshot: calls ledger.balance, checks quota, calls manager.create, emits meter event", async () => {
      const { service, manager, meter, ledger } = makeService();
      const result = await service.create(createParams);

      expect(ledger.balance).toHaveBeenCalledWith("tenant-a");
      expect(manager.countByTenant).toHaveBeenCalledWith("tenant-a", "on-demand");
      expect(manager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "tenant-a",
          instanceId: "bot-1",
          type: "on-demand",
          trigger: "manual",
        }),
      );
      expect(meter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "tenant-a",
          capability: "storage",
          provider: "do-spaces",
        }),
      );
      expect(result.snapshot).toBeDefined();
      expect(result.estimatedMonthlyCostCents).toBeGreaterThanOrEqual(0);
    });

    it("passes expiresAt based on tier retention policy", async () => {
      const { service, manager } = makeService();
      await service.create({ ...createParams, tier: "starter" });

      const call = (manager.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const expectedRetention = SNAPSHOT_TIER_POLICIES.starter.retentionDays * 24 * 60 * 60 * 1000;
      expect(call.expiresAt).toBeGreaterThan(Date.now());
      expect(call.expiresAt).toBeLessThanOrEqual(Date.now() + expectedRetention + 1000);
    });

    it("throws InsufficientCreditsError when balance is 0", async () => {
      const { service } = makeService({}, 0);
      await expect(service.create(createParams)).rejects.toThrow(InsufficientCreditsError);
    });

    it("throws InsufficientCreditsError when balance is negative", async () => {
      const { service } = makeService({}, -100);
      await expect(service.create(createParams)).rejects.toThrow(InsufficientCreditsError);
    });

    it("throws SnapshotQuotaExceededError when quota full", async () => {
      const max = SNAPSHOT_TIER_POLICIES.free.onDemandMax;
      const { service } = makeService({ countByTenant: vi.fn().mockReturnValue(max) });
      await expect(service.create(createParams)).rejects.toThrow(SnapshotQuotaExceededError);
    });
  });

  describe("delete", () => {
    it("returns false for nonexistent snapshot", async () => {
      const { service } = makeService({ get: vi.fn().mockReturnValue(null) });
      const result = await service.delete("snap-missing", "tenant-a");
      expect(result).toBe(false);
    });

    it("returns false for snapshot owned by different tenant", async () => {
      const snap = makeSnapshot({ tenant: "tenant-b" });
      const { service } = makeService({ get: vi.fn().mockReturnValue(snap) });
      const result = await service.delete("snap-1", "tenant-a");
      expect(result).toBe(false);
    });

    it("throws for nightly type snapshot", async () => {
      const snap = makeSnapshot({ type: "nightly", tenant: "tenant-a" });
      const { service } = makeService({ get: vi.fn().mockReturnValue(snap) });
      await expect(service.delete("snap-1", "tenant-a")).rejects.toThrow("Only on-demand snapshots");
    });

    it("deletes successfully for on-demand snapshot owned by tenant", async () => {
      const snap = makeSnapshot({ type: "on-demand", tenant: "tenant-a" });
      const { service } = makeService({ get: vi.fn().mockReturnValue(snap), delete: vi.fn().mockResolvedValue(true) });
      const result = await service.delete("snap-1", "tenant-a");
      expect(result).toBe(true);
    });
  });

  describe("list", () => {
    it("filters by tenant and excludes soft-deleted", () => {
      const snaps: Snapshot[] = [
        makeSnapshot({ id: "s1", tenant: "tenant-a", deletedAt: null }),
        makeSnapshot({ id: "s2", tenant: "tenant-a", deletedAt: Date.now() }), // soft-deleted
        makeSnapshot({ id: "s3", tenant: "tenant-b", deletedAt: null }), // different tenant
      ];
      const { service } = makeService({ list: vi.fn().mockReturnValue(snaps) });
      const result = service.list("tenant-a", "bot-1");

      // Should only include s1 (not soft-deleted, correct tenant)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("s1");
    });
  });
});
