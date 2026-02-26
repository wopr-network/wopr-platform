import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleGpuNodeRepository } from "./gpu-node-repository.js";

describe("DrizzleGpuNodeRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleGpuNodeRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleGpuNodeRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("insert + getById round-trip", () => {
    it("inserts a new GPU node and retrieves it by ID", async () => {
      const node = await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });

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

      const fetched = await repo.getById("gpu-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe("gpu-1");
      expect(fetched?.region).toBe("nyc1");
    });

    it("getById returns null for nonexistent node", async () => {
      expect(await repo.getById("nope")).toBeNull();
    });
  });

  describe("updateServiceHealth JSON round-trip", () => {
    it("stores and retrieves serviceHealth as JSON", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });

      const health: Record<string, "ok" | "down"> = { vllm: "ok", whisper: "down" };
      const now = Math.floor(Date.now() / 1000);
      await repo.updateServiceHealth("gpu-1", health, now);

      const fetched = await repo.getById("gpu-1");
      expect(fetched?.serviceHealth).toEqual({ vllm: "ok", whisper: "down" });
      expect(fetched?.lastHealthAt).toBe(now);
    });

    it("overwrites previous serviceHealth", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });

      await repo.updateServiceHealth("gpu-1", { vllm: "ok" }, 100);
      await repo.updateServiceHealth("gpu-1", { vllm: "down", whisper: "ok" }, 200);

      const fetched = await repo.getById("gpu-1");
      expect(fetched?.serviceHealth).toEqual({ vllm: "down", whisper: "ok" });
      expect(fetched?.lastHealthAt).toBe(200);
    });

    it("throws when updating nonexistent node", async () => {
      await expect(repo.updateServiceHealth("nope", { vllm: "ok" }, 100)).rejects.toThrow("GPU node not found: nope");
    });
  });

  describe("list() with status filter", () => {
    it("returns all nodes when no statuses provided", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });

      const all = await repo.list();
      expect(all).toHaveLength(2);
    });

    it("filters by single status", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });

      // Transition gpu-2 to active
      await repo.updateStatus("gpu-2", "active");

      const active = await repo.list(["active"]);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("gpu-2");
    });

    it("filters by multiple statuses", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });
      await repo.insert({ id: "gpu-3", region: "lon1", size: "gpu-h100x1-80gb" });

      await repo.updateStatus("gpu-2", "active");
      await repo.updateStatus("gpu-3", "failed");

      const results = await repo.list(["active", "failed"]);
      expect(results).toHaveLength(2);
      expect(results.map((n) => n.id).sort()).toEqual(["gpu-2", "gpu-3"]);
    });
  });

  describe("updateStage", () => {
    it("updates provisionStage", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.updateStage("gpu-1", "pulling_image");
      const node = await repo.getById("gpu-1");
      expect(node?.provisionStage).toBe("pulling_image");
    });

    it("throws when updating nonexistent node", async () => {
      await expect(repo.updateStage("nope", "pending")).rejects.toThrow("GPU node not found: nope");
    });
  });

  describe("updateStatus", () => {
    it("updates status", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.updateStatus("gpu-1", "active");
      const node = await repo.getById("gpu-1");
      expect(node?.status).toBe("active");
    });

    it("throws when updating nonexistent node", async () => {
      await expect(repo.updateStatus("nope", "active")).rejects.toThrow("GPU node not found: nope");
    });
  });

  describe("updateHost", () => {
    it("updates host, dropletId, and monthlyCostCents", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.updateHost("gpu-1", "10.0.0.5", "droplet-123", 250000);

      const node = await repo.getById("gpu-1");
      expect(node?.host).toBe("10.0.0.5");
      expect(node?.dropletId).toBe("droplet-123");
      expect(node?.monthlyCostCents).toBe(250000);
    });

    it("throws when updating nonexistent node", async () => {
      await expect(repo.updateHost("nope", "10.0.0.1", "d-1", 100)).rejects.toThrow("GPU node not found: nope");
    });
  });

  describe("setError", () => {
    it("sets lastError", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.setError("gpu-1", "CUDA out of memory");
      const node = await repo.getById("gpu-1");
      expect(node?.lastError).toBe("CUDA out of memory");
    });

    it("throws when updating nonexistent node", async () => {
      await expect(repo.setError("nope", "fail")).rejects.toThrow("GPU node not found: nope");
    });
  });

  describe("delete", () => {
    it("deletes a node", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.delete("gpu-1");
      expect(await repo.getById("gpu-1")).toBeNull();
    });

    it("throws when deleting nonexistent node", async () => {
      await expect(repo.delete("nope")).rejects.toThrow("GPU node not found: nope");
    });

    it("does not affect other nodes", async () => {
      await repo.insert({ id: "gpu-1", region: "nyc1", size: "gpu-h100x1-80gb" });
      await repo.insert({ id: "gpu-2", region: "sfo1", size: "gpu-h100x1-80gb" });
      await repo.delete("gpu-1");
      expect(await repo.getById("gpu-2")).not.toBeNull();
      expect(await repo.list()).toHaveLength(1);
    });
  });
});
