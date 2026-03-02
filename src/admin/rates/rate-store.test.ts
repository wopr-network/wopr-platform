import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { RateStore } from "./rate-store.js";

describe("RateStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: RateStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    store = new RateStore(db);
  });

  describe("createSellRate", () => {
    it("creates and retrieves a sell rate", async () => {
      const rate = await store.createSellRate({
        capability: "llm",
        displayName: "LLM Chat",
        unit: "token",
        priceUsd: 0.001,
      });

      expect(rate.id).toEqual(expect.any(String));
      expect(rate.capability).toBe("llm");
      expect(rate.display_name).toBe("LLM Chat");
      expect(rate.unit).toBe("token");
      expect(rate.price_usd).toBe(0.001);
      expect(rate.is_active).toBe(true);
      expect(rate.model).toBeNull();
    });

    it("enforces NULL-model uniqueness per capability", async () => {
      await store.createSellRate({
        capability: "llm",
        displayName: "LLM Default",
        unit: "token",
        priceUsd: 0.001,
      });

      await expect(
        store.createSellRate({
          capability: "llm",
          displayName: "LLM Duplicate",
          unit: "token",
          priceUsd: 0.002,
        }),
      ).rejects.toThrow("already exists");
    });

    it("allows same capability with different models", async () => {
      await store.createSellRate({
        capability: "llm",
        displayName: "LLM GPT-4",
        unit: "token",
        priceUsd: 0.003,
        model: "gpt-4",
      });
      const rate2 = await store.createSellRate({
        capability: "llm",
        displayName: "LLM Claude",
        unit: "token",
        priceUsd: 0.002,
        model: "claude-3",
      });
      expect(rate2.model).toBe("claude-3");
    });
  });

  describe("getSellRate", () => {
    it("returns the sell rate when it exists", async () => {
      const rate = await store.createSellRate({
        capability: "tts",
        displayName: "TTS",
        unit: "char",
        priceUsd: 0.0001,
      });

      const fetched = await store.getSellRate(rate.id);
      expect(fetched?.id).toBe(rate.id);
    });

    it("returns null for non-existent sell rate", async () => {
      expect(await store.getSellRate("nonexistent")).toBeNull();
    });
  });

  describe("updateSellRate", () => {
    it("updates a sell rate", async () => {
      const rate = await store.createSellRate({
        capability: "llm",
        displayName: "LLM Chat",
        unit: "token",
        priceUsd: 0.001,
      });

      const updated = await store.updateSellRate(rate.id, { priceUsd: 0.002, displayName: "LLM Chat v2" });
      expect(updated.price_usd).toBe(0.002);
      expect(updated.display_name).toBe("LLM Chat v2");
    });

    it("throws when updating non-existent sell rate", async () => {
      await expect(store.updateSellRate("nope", { priceUsd: 1 })).rejects.toThrow("not found");
    });
  });

  describe("deleteSellRate", () => {
    it("deletes a sell rate", async () => {
      const rate = await store.createSellRate({
        capability: "tts",
        displayName: "TTS",
        unit: "char",
        priceUsd: 0.0001,
      });

      expect(await store.deleteSellRate(rate.id)).toBe(true);
      expect(await store.getSellRate(rate.id)).toBeNull();
    });

    it("returns false when deleting non-existent sell rate", async () => {
      expect(await store.deleteSellRate("nope")).toBe(false);
    });
  });

  describe("listSellRates", () => {
    it("returns all sell rates with total count", async () => {
      await store.createSellRate({ capability: "llm", displayName: "LLM", unit: "token", priceUsd: 0.001, model: "a" });
      await store.createSellRate({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.0001 });

      const { entries, total } = await store.listSellRates();
      expect(total).toBe(2);
      expect(entries).toHaveLength(2);
    });

    it("filters by capability", async () => {
      await store.createSellRate({ capability: "llm", displayName: "LLM", unit: "token", priceUsd: 0.001 });
      await store.createSellRate({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.0001 });

      const { entries } = await store.listSellRates({ capability: "llm" });
      expect(entries).toHaveLength(1);
      expect(entries[0].capability).toBe("llm");
    });

    it("filters by isActive", async () => {
      await store.createSellRate({
        capability: "llm",
        displayName: "LLM",
        unit: "token",
        priceUsd: 0.001,
        isActive: false,
      });
      await store.createSellRate({
        capability: "tts",
        displayName: "TTS",
        unit: "char",
        priceUsd: 0.0001,
        isActive: true,
      });

      const { entries } = await store.listSellRates({ isActive: true });
      expect(entries).toHaveLength(1);
      expect(entries[0].capability).toBe("tts");
    });

    it("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await store.createSellRate({ capability: `cap-${i}`, displayName: `Cap ${i}`, unit: "u", priceUsd: i * 0.001 });
      }

      const { entries, total } = await store.listSellRates({ limit: 2, offset: 1 });
      expect(total).toBe(5);
      expect(entries).toHaveLength(2);
    });
  });

  describe("getSellRateByModel", () => {
    it("returns active sell rate matching capability and model", async () => {
      await store.createSellRate({
        capability: "llm",
        displayName: "GPT-4",
        unit: "token",
        priceUsd: 0.003,
        model: "gpt-4",
      });

      const rate = await store.getSellRateByModel("llm", "gpt-4");
      expect(rate).not.toBeNull();
      expect(rate?.model).toBe("gpt-4");
    });

    it("returns null for inactive sell rate", async () => {
      await store.createSellRate({
        capability: "llm",
        displayName: "GPT-4",
        unit: "token",
        priceUsd: 0.003,
        model: "gpt-4-inactive",
        isActive: false,
      });

      const rate = await store.getSellRateByModel("llm", "gpt-4-inactive");
      expect(rate).toBeNull();
    });

    it("returns null when not found", async () => {
      const rate = await store.getSellRateByModel("llm", "nonexistent-model");
      expect(rate).toBeNull();
    });
  });

  describe("listPublicRates", () => {
    it("returns only active rates", async () => {
      await store.createSellRate({
        capability: "llm",
        displayName: "LLM",
        unit: "token",
        priceUsd: 0.001,
        isActive: true,
      });
      await store.createSellRate({
        capability: "tts",
        displayName: "TTS",
        unit: "char",
        priceUsd: 0.0001,
        isActive: false,
      });

      const rates = await store.listPublicRates();
      expect(rates).toHaveLength(1);
      expect(rates[0].capability).toBe("llm");
    });

    it("returns empty array when no active rates", async () => {
      const rates = await store.listPublicRates();
      expect(rates).toEqual([]);
    });
  });

  describe("createProviderCost", () => {
    it("creates and retrieves a provider cost", async () => {
      const cost = await store.createProviderCost({
        capability: "llm",
        adapter: "openai",
        unit: "token",
        costUsd: 0.0005,
        model: "gpt-4",
      });

      expect(cost.id).toEqual(expect.any(String));
      expect(cost.capability).toBe("llm");
      expect(cost.adapter).toBe("openai");
      expect(cost.cost_usd).toBe(0.0005);
      expect(cost.model).toBe("gpt-4");
    });

    it("enforces NULL-model uniqueness per capability+adapter", async () => {
      await store.createProviderCost({ capability: "llm", adapter: "openai", unit: "token", costUsd: 0.001 });

      await expect(
        store.createProviderCost({ capability: "llm", adapter: "openai", unit: "token", costUsd: 0.002 }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("getProviderCost", () => {
    it("returns null for non-existent provider cost", async () => {
      expect(await store.getProviderCost("nonexistent")).toBeNull();
    });
  });

  describe("updateProviderCost", () => {
    it("updates a provider cost", async () => {
      const cost = await store.createProviderCost({
        capability: "llm",
        adapter: "openai",
        unit: "token",
        costUsd: 0.0005,
      });

      const updated = await store.updateProviderCost(cost.id, { costUsd: 0.001 });
      expect(updated.cost_usd).toBe(0.001);
    });

    it("throws when updating non-existent provider cost", async () => {
      await expect(store.updateProviderCost("nope", { costUsd: 1 })).rejects.toThrow("not found");
    });
  });

  describe("deleteProviderCost", () => {
    it("deletes a provider cost", async () => {
      const cost = await store.createProviderCost({
        capability: "tts",
        adapter: "kokoro",
        unit: "char",
        costUsd: 0.00005,
      });

      expect(await store.deleteProviderCost(cost.id)).toBe(true);
      expect(await store.getProviderCost(cost.id)).toBeNull();
    });

    it("returns false when deleting non-existent provider cost", async () => {
      expect(await store.deleteProviderCost("nope")).toBe(false);
    });
  });

  describe("getMarginReport", () => {
    it("returns margin report combining sell rates and provider costs", async () => {
      await store.createSellRate({ capability: "llm", displayName: "LLM", unit: "token", priceUsd: 0.003 });
      await store.createProviderCost({ capability: "llm", adapter: "openai", unit: "token", costUsd: 0.001 });

      const report = await store.getMarginReport();
      expect(report).toHaveLength(1);
      expect(report[0].capability).toBe("llm");
      expect(report[0].bestMarginPct).toBeCloseTo(66.67, 0);
    });

    it("filters by capability", async () => {
      await store.createSellRate({ capability: "llm", displayName: "LLM", unit: "token", priceUsd: 0.003 });
      await store.createSellRate({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.001 });

      const report = await store.getMarginReport("llm");
      expect(report).toHaveLength(1);
      expect(report[0].capability).toBe("llm");
    });

    it("returns empty array when no sell rates exist", async () => {
      const report = await store.getMarginReport();
      expect(report).toEqual([]);
    });
  });

  describe("listProviderCosts", () => {
    it("returns all provider costs with total count", async () => {
      await store.createProviderCost({ capability: "llm", adapter: "openai", unit: "token", costUsd: 0.001 });
      await store.createProviderCost({ capability: "tts", adapter: "kokoro", unit: "char", costUsd: 0.0001 });

      const { entries, total } = await store.listProviderCosts();
      expect(total).toBe(2);
      expect(entries).toHaveLength(2);
    });

    it("filters by capability", async () => {
      await store.createProviderCost({ capability: "llm", adapter: "openai", unit: "token", costUsd: 0.001 });
      await store.createProviderCost({ capability: "tts", adapter: "kokoro", unit: "char", costUsd: 0.0001 });

      const { entries } = await store.listProviderCosts({ capability: "llm" });
      expect(entries).toHaveLength(1);
      expect(entries[0].capability).toBe("llm");
    });
  });
});
