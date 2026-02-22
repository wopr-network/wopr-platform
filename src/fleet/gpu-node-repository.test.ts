import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleGpuNodeRepository } from "./gpu-node-repository.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE gpu_nodes (
      id TEXT PRIMARY KEY,
      droplet_id TEXT,
      host TEXT,
      region TEXT NOT NULL,
      size TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'provisioning',
      provision_stage TEXT NOT NULL DEFAULT 'pending',
      service_health TEXT,
      monthly_cost_cents INTEGER,
      last_health_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sqlite.exec("CREATE INDEX idx_gpu_nodes_status ON gpu_nodes (status)");

  return { db, sqlite };
}

describe("DrizzleGpuNodeRepository", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let repo: DrizzleGpuNodeRepository;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    repo = new DrizzleGpuNodeRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("insert + getById round-trip", () => {
    it("inserts a new GPU node and retrieves it by ID", () => {
      const node = repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });

      expect(node.id).toBe("gpu-1");
      expect(node.region).toBe("nyc1");
      expect(node.size).toBe("gpu-h100x1-80gb");
      expect(node.status).toBe("provisioning");
      expect(node.provisionStage).toBe("pending");
      expect(node.dropletId).toBeNull();
      expect(node.host).toBeNull();
      expect(node.serviceHealth).toBeNull();
      expect(node.monthlyCostCents).toBeNull();
      expect(node.lastHealthAt).toBeNull();
      expect(node.lastError).toBeNull();
      expect(typeof node.createdAt).toBe("number");
      expect(typeof node.updatedAt).toBe("number");

      const fetched = repo.getById("gpu-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe("gpu-1");
      expect(fetched?.region).toBe("nyc1");
    });

    it("getById returns null for nonexistent node", () => {
      expect(repo.getById("nope")).toBeNull();
    });
  });

  describe("updateServiceHealth JSON round-trip", () => {
    it("stores and retrieves serviceHealth as JSON", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });

      const health: Record<string, "ok" | "down"> = { vllm: "ok", whisper: "down" };
      const now = Math.floor(Date.now() / 1000);
      repo.updateServiceHealth("gpu-1", health, now);

      const fetched = repo.getById("gpu-1");
      expect(fetched?.serviceHealth).toEqual({ vllm: "ok", whisper: "down" });
      expect(fetched?.lastHealthAt).toBe(now);
    });

    it("overwrites previous serviceHealth", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });

      repo.updateServiceHealth("gpu-1", { vllm: "ok" }, 100);
      repo.updateServiceHealth("gpu-1", { vllm: "down", whisper: "ok" }, 200);

      const fetched = repo.getById("gpu-1");
      expect(fetched?.serviceHealth).toEqual({ vllm: "down", whisper: "ok" });
      expect(fetched?.lastHealthAt).toBe(200);
    });

    it("throws when updating nonexistent node", () => {
      expect(() => repo.updateServiceHealth("nope", { vllm: "ok" }, 100)).toThrow("GPU node not found: nope");
    });
  });

  describe("list() with status filter", () => {
    it("returns all nodes when no statuses provided", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });

      const all = repo.list();
      expect(all).toHaveLength(2);
    });

    it("filters by single status", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });

      // Transition gpu-2 to active
      repo.updateStatus("gpu-2", "active");

      const active = repo.list(["active"]);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("gpu-2");
    });

    it("filters by multiple statuses", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });
      repo.insert({ id: "gpu-3", region: "lon1", size: "gpu-h100x1-80gb" });

      repo.updateStatus("gpu-2", "active");
      repo.updateStatus("gpu-3", "failed");

      const results = repo.list(["active", "failed"]);
      expect(results).toHaveLength(2);
      expect(results.map((n) => n.id).sort()).toEqual(["gpu-2", "gpu-3"]);
    });
  });

  describe("updateStage", () => {
    it("updates provisionStage", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.updateStage("gpu-1", "pulling_image");
      const node = repo.getById("gpu-1");
      expect(node?.provisionStage).toBe("pulling_image");
    });

    it("throws when updating nonexistent node", () => {
      expect(() => repo.updateStage("nope", "pending")).toThrow("GPU node not found: nope");
    });
  });

  describe("updateStatus", () => {
    it("updates status", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.updateStatus("gpu-1", "active");
      const node = repo.getById("gpu-1");
      expect(node?.status).toBe("active");
    });

    it("throws when updating nonexistent node", () => {
      expect(() => repo.updateStatus("nope", "active")).toThrow("GPU node not found: nope");
    });
  });

  describe("updateHost", () => {
    it("updates host, dropletId, and monthlyCostCents", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.updateHost("gpu-1", "10.0.0.5", "droplet-123", 250000);

      const node = repo.getById("gpu-1");
      expect(node?.host).toBe("10.0.0.5");
      expect(node?.dropletId).toBe("droplet-123");
      expect(node?.monthlyCostCents).toBe(250000);
    });

    it("throws when updating nonexistent node", () => {
      expect(() => repo.updateHost("nope", "10.0.0.1", "d-1", 100)).toThrow("GPU node not found: nope");
    });
  });

  describe("setError", () => {
    it("sets lastError", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.setError("gpu-1", "CUDA out of memory");
      const node = repo.getById("gpu-1");
      expect(node?.lastError).toBe("CUDA out of memory");
    });

    it("throws when updating nonexistent node", () => {
      expect(() => repo.setError("nope", "fail")).toThrow("GPU node not found: nope");
    });
  });

  describe("delete", () => {
    it("deletes a node", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.delete("gpu-1");
      expect(repo.getById("gpu-1")).toBeNull();
    });

    it("throws when deleting nonexistent node", () => {
      expect(() => repo.delete("nope")).toThrow("GPU node not found: nope");
    });

    it("does not affect other nodes", () => {
      repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });
      repo.delete("gpu-1");
      expect(repo.getById("gpu-2")).not.toBeNull();
      expect(repo.list()).toHaveLength(1);
    });
  });
});
