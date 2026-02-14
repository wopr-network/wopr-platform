import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIERS, type PlanTier, SpendOverrideStore, TierStore } from "./tier-definitions.js";

describe("TierStore", () => {
  let db: Database.Database;
  let store: TierStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new TierStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("init and seed", () => {
    it("creates the plan_tiers table on construction", () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_tiers'").all() as {
        name: string;
      }[];
      expect(tables).toHaveLength(1);
    });

    it("seeds default tiers", () => {
      store.seed();
      const tiers = store.list();
      expect(tiers).toHaveLength(DEFAULT_TIERS.length);
    });

    it("seed is idempotent (INSERT OR IGNORE)", () => {
      store.seed();
      store.seed();
      const tiers = store.list();
      expect(tiers).toHaveLength(DEFAULT_TIERS.length);
    });
  });

  describe("get", () => {
    beforeEach(() => {
      store.seed();
    });

    it("returns a tier by ID", () => {
      const tier = store.get("free");
      expect(tier).not.toBeNull();
      expect(tier?.name).toBe("free");
      expect(tier?.maxInstances).toBe(1);
      expect(tier?.memoryLimitMb).toBe(512);
    });

    it("returns null for unknown tier", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("parses features as array", () => {
      const pro = store.get("pro");
      expect(pro).not.toBeNull();
      expect(pro?.features).toEqual(["premium_plugins", "priority-support", "custom-domains"]);
    });

    it("handles null maxPluginsPerInstance", () => {
      const pro = store.get("pro");
      expect(pro?.maxPluginsPerInstance).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no tiers exist", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns tiers ordered by max_instances ascending", () => {
      store.seed();
      const tiers = store.list();
      // enterprise has maxInstances=0 (unlimited), so it sorts first
      // free=1, pro=5, team=20
      expect(tiers[0].name).toBe("enterprise");
      expect(tiers[1].name).toBe("free");
      expect(tiers[2].name).toBe("pro");
      expect(tiers[3].name).toBe("team");
    });
  });

  describe("upsert", () => {
    it("inserts a new tier", () => {
      const custom: PlanTier = {
        id: "custom",
        name: "custom",
        maxInstances: 10,
        maxPluginsPerInstance: 20,
        memoryLimitMb: 1024,
        cpuQuota: 100_000,
        storageLimitMb: 5120,
        maxProcesses: 512,
        features: ["custom-feature"],
        maxSpendPerHour: 5,
        maxSpendPerMonth: 100,
        platformFeeUsd: 25,
        includedTokens: 1_000_000,
        overageMarkupPercent: 15,
        byokAllowed: false,
      };
      store.upsert(custom);
      const result = store.get("custom");
      expect(result).toEqual(custom);
    });

    it("updates an existing tier", () => {
      store.seed();
      const existing = store.get("free");
      expect(existing).not.toBeNull();
      const updated = { ...existing, memoryLimitMb: 1024 } as PlanTier;
      store.upsert(updated);
      expect(store.get("free")?.memoryLimitMb).toBe(1024);
    });
  });

  describe("delete", () => {
    it("deletes an existing tier and returns true", () => {
      store.seed();
      expect(store.delete("free")).toBe(true);
      expect(store.get("free")).toBeNull();
    });

    it("returns false for non-existent tier", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("DEFAULT_TIERS", () => {
    it("has 4 default tiers", () => {
      expect(DEFAULT_TIERS).toHaveLength(4);
    });

    it("free tier has correct limits", () => {
      const free = DEFAULT_TIERS.find((t) => t.id === "free");
      expect(free).toBeDefined();
      expect(free?.maxInstances).toBe(1);
      expect(free?.maxPluginsPerInstance).toBe(5);
      expect(free?.memoryLimitMb).toBe(512);
      expect(free?.cpuQuota).toBe(50_000);
    });

    it("enterprise tier has unlimited instances", () => {
      const ent = DEFAULT_TIERS.find((t) => t.id === "enterprise");
      expect(ent).toBeDefined();
      expect(ent?.maxInstances).toBe(0);
      expect(ent?.maxPluginsPerInstance).toBeNull();
    });

    it("free tier has spend limits", () => {
      const free = DEFAULT_TIERS.find((t) => t.id === "free");
      expect(free?.maxSpendPerHour).toBe(0.5);
      expect(free?.maxSpendPerMonth).toBe(5);
    });

    it("enterprise tier has unlimited spend", () => {
      const ent = DEFAULT_TIERS.find((t) => t.id === "enterprise");
      expect(ent?.maxSpendPerHour).toBeNull();
      expect(ent?.maxSpendPerMonth).toBeNull();
    });

    it("free tier has correct pricing config", () => {
      const free = DEFAULT_TIERS.find((t) => t.id === "free");
      expect(free?.platformFeeUsd).toBe(0);
      expect(free?.includedTokens).toBe(50_000);
      expect(free?.overageMarkupPercent).toBe(20);
      expect(free?.byokAllowed).toBe(false);
    });

    it("pro tier has correct pricing config", () => {
      const pro = DEFAULT_TIERS.find((t) => t.id === "pro");
      expect(pro?.platformFeeUsd).toBe(19);
      expect(pro?.includedTokens).toBe(2_000_000);
      expect(pro?.overageMarkupPercent).toBe(10);
      expect(pro?.byokAllowed).toBe(true);
    });

    it("team tier has correct pricing config", () => {
      const team = DEFAULT_TIERS.find((t) => t.id === "team");
      expect(team?.platformFeeUsd).toBe(49);
      expect(team?.includedTokens).toBe(5_000_000);
      expect(team?.overageMarkupPercent).toBe(8);
      expect(team?.byokAllowed).toBe(true);
    });

    it("enterprise tier has correct pricing config", () => {
      const ent = DEFAULT_TIERS.find((t) => t.id === "enterprise");
      expect(ent?.platformFeeUsd).toBe(0); // Custom pricing
      expect(ent?.includedTokens).toBe(0); // Custom pricing
      expect(ent?.overageMarkupPercent).toBe(5);
      expect(ent?.byokAllowed).toBe(true);
    });
  });

  describe("spend limits in store", () => {
    beforeEach(() => {
      store.seed();
    });

    it("stores and retrieves spend limits for free tier", () => {
      const free = store.get("free");
      expect(free?.maxSpendPerHour).toBe(0.5);
      expect(free?.maxSpendPerMonth).toBe(5);
    });

    it("stores and retrieves null spend limits for enterprise", () => {
      const ent = store.get("enterprise");
      expect(ent?.maxSpendPerHour).toBeNull();
      expect(ent?.maxSpendPerMonth).toBeNull();
    });

    it("updates spend limits via upsert", () => {
      const free = store.get("free")!;
      store.upsert({ ...free, maxSpendPerHour: 1.0, maxSpendPerMonth: 10 });
      const updated = store.get("free");
      expect(updated?.maxSpendPerHour).toBe(1.0);
      expect(updated?.maxSpendPerMonth).toBe(10);
    });
  });

  describe("pricing fields in store", () => {
    beforeEach(() => {
      store.seed();
    });

    it("stores and retrieves pricing fields for free tier", () => {
      const free = store.get("free");
      expect(free?.platformFeeUsd).toBe(0);
      expect(free?.includedTokens).toBe(50_000);
      expect(free?.overageMarkupPercent).toBe(20);
      expect(free?.byokAllowed).toBe(false);
    });

    it("stores and retrieves pricing fields for pro tier", () => {
      const pro = store.get("pro");
      expect(pro?.platformFeeUsd).toBe(19);
      expect(pro?.includedTokens).toBe(2_000_000);
      expect(pro?.overageMarkupPercent).toBe(10);
      expect(pro?.byokAllowed).toBe(true);
    });

    it("stores and retrieves pricing fields for enterprise tier", () => {
      const ent = store.get("enterprise");
      expect(ent?.platformFeeUsd).toBe(0);
      expect(ent?.includedTokens).toBe(0);
      expect(ent?.overageMarkupPercent).toBe(5);
      expect(ent?.byokAllowed).toBe(true);
    });

    it("updates pricing fields via upsert", () => {
      const pro = store.get("pro")!;
      store.upsert({
        ...pro,
        platformFeeUsd: 29,
        includedTokens: 3_000_000,
        overageMarkupPercent: 12,
        byokAllowed: false,
      });
      const updated = store.get("pro");
      expect(updated?.platformFeeUsd).toBe(29);
      expect(updated?.includedTokens).toBe(3_000_000);
      expect(updated?.overageMarkupPercent).toBe(12);
      expect(updated?.byokAllowed).toBe(false);
    });

    it("inserts a new tier with pricing fields", () => {
      const custom: PlanTier = {
        id: "custom-tier",
        name: "custom-tier",
        maxInstances: 10,
        maxPluginsPerInstance: 20,
        memoryLimitMb: 1024,
        cpuQuota: 100_000,
        storageLimitMb: 5120,
        maxProcesses: 512,
        features: ["custom-feature"],
        maxSpendPerHour: 5,
        maxSpendPerMonth: 100,
        platformFeeUsd: 39,
        includedTokens: 4_000_000,
        overageMarkupPercent: 15,
        byokAllowed: true,
      };
      store.upsert(custom);
      const result = store.get("custom-tier");
      expect(result).toEqual(custom);
    });
  });

  describe("creates tenant_spend_overrides table", () => {
    it("tenant_spend_overrides table exists after TierStore construction", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_spend_overrides'")
        .all() as { name: string }[];
      expect(tables).toHaveLength(1);
    });
  });
});

describe("SpendOverrideStore", () => {
  let db: Database.Database;
  let store: SpendOverrideStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SpendOverrideStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the tenant_spend_overrides table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_spend_overrides'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("returns null for unknown tenant", () => {
    expect(store.get("unknown-tenant")).toBeNull();
  });

  it("sets and gets a spend override", () => {
    store.set("tenant-1", { maxSpendPerHour: 2.0, maxSpendPerMonth: 50 });
    const override = store.get("tenant-1");
    expect(override).not.toBeNull();
    expect(override?.tenant).toBe("tenant-1");
    expect(override?.maxSpendPerHour).toBe(2.0);
    expect(override?.maxSpendPerMonth).toBe(50);
    expect(override?.updatedAt).toBeGreaterThan(0);
  });

  it("upserts an existing override", () => {
    store.set("tenant-1", { maxSpendPerHour: 2.0, maxSpendPerMonth: 50 });
    store.set("tenant-1", { maxSpendPerHour: 5.0 });
    const override = store.get("tenant-1");
    expect(override?.maxSpendPerHour).toBe(5.0);
    expect(override?.maxSpendPerMonth).toBe(50); // unchanged
  });

  it("stores notes", () => {
    store.set("tenant-1", { maxSpendPerHour: 1.0, notes: "VIP customer" });
    const override = store.get("tenant-1");
    expect(override?.notes).toBe("VIP customer");
  });

  it("deletes an override", () => {
    store.set("tenant-1", { maxSpendPerHour: 2.0, maxSpendPerMonth: 50 });
    expect(store.delete("tenant-1")).toBe(true);
    expect(store.get("tenant-1")).toBeNull();
  });

  it("returns false when deleting non-existent override", () => {
    expect(store.delete("unknown")).toBe(false);
  });

  it("lists all overrides", () => {
    store.set("tenant-a", { maxSpendPerHour: 1.0 });
    store.set("tenant-b", { maxSpendPerMonth: 100 });
    const overrides = store.list();
    expect(overrides).toHaveLength(2);
    expect(overrides[0].tenant).toBe("tenant-a");
    expect(overrides[1].tenant).toBe("tenant-b");
  });

  it("returns empty list when no overrides exist", () => {
    expect(store.list()).toEqual([]);
  });
});
