import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIERS, type PlanTier, TierStore } from "./tier-definitions.js";

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
      expect(pro?.features).toEqual(["priority-support", "custom-domains"]);
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
  });
});
