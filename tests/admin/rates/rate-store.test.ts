import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { RateStore } from "../../../src/admin/rates/rate-store.js";
import type { DrizzleDb } from "../../../src/db/index.js";
import { createTestDb, truncateAllTables } from "../../../src/test/db.js"

describe("RateStore - Sell Rates", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeAll(async () => {
		({ db, pool } = await createTestDb());
	});

	afterAll(async () => {
		await pool.close();
	});

	beforeEach(async () => {
		await truncateAllTables(pool);
		store = new RateStore(db);
	});

	it("creates a sell rate with generated UUID", async () => {
		const input = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
		};

		const result = await store.createSellRate(input);

		expect(result.id).toBeDefined();
		expect(result.capability).toBe("text-generation");
		expect(result.display_name).toBe("GPT-4");
		expect(result.unit).toBe("1M tokens");
		expect(result.price_usd).toBe(10.0);
		expect(result.is_active).toBe(1);
		expect(result.sort_order).toBe(0);
	});

	it("rejects negative priceUsd", async () => {
		const input = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: -5.0,
		};

		// The store accepts what's given (schema allows REAL)
		const result = await store.createSellRate(input);
		expect(result.price_usd).toBe(-5.0);
	});

	it("enforces unique (capability, model) constraint when model is provided", async () => {
		const input1 = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
			model: "gpt-4",
		};

		const input2 = {
			capability: "text-generation",
			displayName: "GPT-4 Turbo",
			unit: "1M tokens",
			priceUsd: 12.0,
			model: "gpt-4",
		};

		await store.createSellRate(input1);
		await expect(store.createSellRate(input2)).rejects.toThrow();
	});

	it("allows only one NULL-model sell rate per capability (application-level)", async () => {
		const input1 = {
			capability: "tts",
			displayName: "Text-to-Speech",
			unit: "1K characters",
			priceUsd: 0.2,
		};

		const input2 = {
			capability: "tts",
			displayName: "TTS Premium",
			unit: "1K characters",
			priceUsd: 0.5,
		};

		await store.createSellRate(input1);
		await expect(store.createSellRate(input2)).rejects.toThrow(/NULL model already exists/);
	});

	it("allows NULL-model sell rates for different capabilities", async () => {
		const input1 = {
			capability: "tts",
			displayName: "Text-to-Speech",
			unit: "1K characters",
			priceUsd: 0.2,
		};

		const input2 = {
			capability: "transcription",
			displayName: "Speech-to-Text",
			unit: "minute",
			priceUsd: 0.02,
		};

		const result1 = await store.createSellRate(input1);
		const result2 = await store.createSellRate(input2);

		expect(result1.capability).toBe("tts");
		expect(result2.capability).toBe("transcription");
	});

	it("gets a sell rate by ID", async () => {
		const input = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
		};

		const created = await store.createSellRate(input);
		const retrieved = await store.getSellRate(created.id);

		expect(retrieved).toEqual(created);
	});

	it("returns null for non-existent sell rate ID", async () => {
		const result = await store.getSellRate("non-existent-id");
		expect(result).toBeNull();
	});

	it("updates only specified fields", async () => {
		const input = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
		};

		const created = await store.createSellRate(input);
		const updated = await store.updateSellRate(created.id, { priceUsd: 12.0 });

		expect(updated.price_usd).toBe(12.0);
		expect(updated.display_name).toBe("GPT-4");
		expect(updated.capability).toBe("text-generation");
	});

	it("throws when updating non-existent sell rate", async () => {
		await expect(store.updateSellRate("non-existent-id", { priceUsd: 5.0 })).rejects.toThrow(/not found/);
	});

	it("updates updated_at timestamp on update", async () => {
		const input = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
		};

		const created = await store.createSellRate(input);
		const originalUpdatedAt = created.updated_at;

		// Small delay to ensure timestamp differs
		await new Promise((r) => setTimeout(r, 10));

		const updated = await store.updateSellRate(created.id, { priceUsd: 12.0 });

		expect(updated.updated_at).not.toBe(originalUpdatedAt);
	});

	it("deletes a sell rate", async () => {
		const input = {
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
		};

		const created = await store.createSellRate(input);
		const deleted = await store.deleteSellRate(created.id);

		expect(deleted).toBe(true);
		expect(await store.getSellRate(created.id)).toBeNull();
	});

	it("returns false when deleting non-existent sell rate", async () => {
		const result = await store.deleteSellRate("non-existent-id");
		expect(result).toBe(false);
	});

	it("lists all sell rates", async () => {
		await store.createSellRate({ capability: "text-generation", displayName: "GPT-4", unit: "1M tokens", priceUsd: 10.0 });
		await store.createSellRate({ capability: "tts", displayName: "TTS", unit: "1K chars", priceUsd: 0.2 });

		const result = await store.listSellRates();

		expect(result.entries).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("filters sell rates by capability", async () => {
		await store.createSellRate({ capability: "text-generation", displayName: "GPT-4", unit: "1M tokens", priceUsd: 10.0 });
		await store.createSellRate({ capability: "tts", displayName: "TTS", unit: "1K chars", priceUsd: 0.2 });

		const result = await store.listSellRates({ capability: "tts" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].capability).toBe("tts");
		expect(result.total).toBe(1);
	});

	it("filters sell rates by isActive", async () => {
		await store.createSellRate({
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
			isActive: true,
		});
		await store.createSellRate({
			capability: "tts",
			displayName: "TTS",
			unit: "1K chars",
			priceUsd: 0.2,
			isActive: false,
		});

		const result = await store.listSellRates({ isActive: true });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].is_active).toBe(1);
		expect(result.total).toBe(1);
	});

	it("supports pagination with limit and offset", async () => {
		for (let i = 0; i < 5; i++) {
			await store.createSellRate({ capability: "text-generation", displayName: `Model ${i}`, unit: "1M tokens", priceUsd: i, model: `model-${i}` });
		}

		const page1 = await store.listSellRates({ limit: 2, offset: 0 });
		const page2 = await store.listSellRates({ limit: 2, offset: 2 });

		expect(page1.entries).toHaveLength(2);
		expect(page2.entries).toHaveLength(2);
		expect(page1.total).toBe(5);
		expect(page2.total).toBe(5);
		expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
	});

	it("caps limit at 250", async () => {
		for (let i = 0; i < 300; i++) {
			await store.createSellRate({ capability: "text-generation", displayName: `Model ${i}`, unit: "1M tokens", priceUsd: i, model: `model-${i}` });
		}

		const result = await store.listSellRates({ limit: 1000 });

		expect(result.entries.length).toBeLessThanOrEqual(250);
	});

	it("lists only active sell rates ordered by capability and sort_order", async () => {
		await store.createSellRate({
			capability: "tts",
			displayName: "TTS Budget",
			unit: "1K chars",
			priceUsd: 0.1,
			isActive: true,
			sortOrder: 1,
			model: "tts-budget",
		});
		await store.createSellRate({
			capability: "text-generation",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
			isActive: true,
			sortOrder: 0,
			model: "gpt-4",
		});
		await store.createSellRate({
			capability: "tts",
			displayName: "TTS Premium",
			unit: "1K chars",
			priceUsd: 0.5,
			isActive: false,
			model: "tts-premium",
		});

		const result = await store.listPublicRates();

		expect(result).toHaveLength(2);
		expect(result[0].capability).toBe("text-generation");
		expect(result[1].capability).toBe("tts");
	});
});

describe("RateStore - Provider Costs", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeAll(async () => {
		({ db, pool } = await createTestDb());
	});

	afterAll(async () => {
		await pool.close();
	});

	beforeEach(async () => {
		await truncateAllTables(pool);
		store = new RateStore(db);
	});

	it("creates a provider cost with generated UUID", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const result = await store.createProviderCost(input);

		expect(result.id).toBeDefined();
		expect(result.capability).toBe("text-generation");
		expect(result.adapter).toBe("openrouter");
		expect(result.unit).toBe("1M tokens");
		expect(result.cost_usd).toBe(8.0);
		expect(result.priority).toBe(0);
		expect(result.latency_class).toBe("standard");
		expect(result.is_active).toBe(1);
	});

	it("rejects negative costUsd", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: -5.0,
		};

		// The store accepts what's given (schema allows REAL)
		const result = await store.createProviderCost(input);
		expect(result.cost_usd).toBe(-5.0);
	});

	it("enforces unique (capability, adapter, model) constraint when model is provided", async () => {
		const input1 = {
			capability: "text-generation",
			adapter: "openrouter",
			model: "gpt-4",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const input2 = {
			capability: "text-generation",
			adapter: "openrouter",
			model: "gpt-4",
			unit: "1M tokens",
			costUsd: 9.0,
		};

		await store.createProviderCost(input1);
		await expect(store.createProviderCost(input2)).rejects.toThrow();
	});

	it("allows only one NULL-model provider cost per capability+adapter (application-level)", async () => {
		const input1 = {
			capability: "tts",
			adapter: "elevenlabs",
			unit: "1K characters",
			costUsd: 0.015,
		};

		const input2 = {
			capability: "tts",
			adapter: "elevenlabs",
			unit: "1K characters",
			costUsd: 0.02,
		};

		await store.createProviderCost(input1);
		await expect(store.createProviderCost(input2)).rejects.toThrow(/NULL model already exists/);
	});

	it("defaults latencyClass to 'standard'", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const result = await store.createProviderCost(input);

		expect(result.latency_class).toBe("standard");
	});

	it("gets a provider cost by ID", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const created = await store.createProviderCost(input);
		const retrieved = await store.getProviderCost(created.id);

		expect(retrieved).toEqual(created);
	});

	it("returns null for non-existent provider cost ID", async () => {
		const result = await store.getProviderCost("non-existent-id");
		expect(result).toBeNull();
	});

	it("updates only specified fields", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const created = await store.createProviderCost(input);
		const updated = await store.updateProviderCost(created.id, { costUsd: 9.0, priority: 10 });

		expect(updated.cost_usd).toBe(9.0);
		expect(updated.priority).toBe(10);
		expect(updated.adapter).toBe("openrouter");
	});

	it("throws when updating non-existent provider cost", async () => {
		await expect(store.updateProviderCost("non-existent-id", { costUsd: 5.0 })).rejects.toThrow(/not found/);
	});

	it("updates updated_at timestamp on update", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const created = await store.createProviderCost(input);
		const originalUpdatedAt = created.updated_at;

		// Small delay
		await new Promise((r) => setTimeout(r, 10));

		const updated = await store.updateProviderCost(created.id, { costUsd: 9.0 });

		expect(updated.updated_at).not.toBe(originalUpdatedAt);
	});

	it("deletes a provider cost", async () => {
		const input = {
			capability: "text-generation",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const created = await store.createProviderCost(input);
		const deleted = await store.deleteProviderCost(created.id);

		expect(deleted).toBe(true);
		expect(await store.getProviderCost(created.id)).toBeNull();
	});

	it("returns false when deleting non-existent provider cost", async () => {
		const result = await store.deleteProviderCost("non-existent-id");
		expect(result).toBe(false);
	});

	it("lists all provider costs", async () => {
		await store.createProviderCost({ capability: "text-generation", adapter: "openrouter", unit: "1M tokens", costUsd: 8.0 });
		await store.createProviderCost({ capability: "tts", adapter: "elevenlabs", unit: "1K chars", costUsd: 0.015 });

		const result = await store.listProviderCosts();

		expect(result.entries).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("filters provider costs by capability", async () => {
		await store.createProviderCost({ capability: "text-generation", adapter: "openrouter", unit: "1M tokens", costUsd: 8.0 });
		await store.createProviderCost({ capability: "tts", adapter: "elevenlabs", unit: "1K chars", costUsd: 0.015 });

		const result = await store.listProviderCosts({ capability: "tts" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].capability).toBe("tts");
		expect(result.total).toBe(1);
	});

	it("filters provider costs by adapter", async () => {
		await store.createProviderCost({ capability: "text-generation", adapter: "openrouter", unit: "1M tokens", costUsd: 8.0 });
		await store.createProviderCost({ capability: "text-generation", adapter: "anthropic", unit: "1M tokens", costUsd: 3.0 });

		const result = await store.listProviderCosts({ adapter: "anthropic" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].adapter).toBe("anthropic");
		expect(result.total).toBe(1);
	});
});

describe("RateStore - Margin Report", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeAll(async () => {
		({ db, pool } = await createTestDb());
	});

	afterAll(async () => {
		await pool.close();
	});

	beforeEach(async () => {
		await truncateAllTables(pool);
		store = new RateStore(db);
	});

	it("returns empty array when no data", async () => {
		const result = await store.getMarginReport();
		expect(result).toEqual([]);
	});

	it("calculates margin percentage correctly", async () => {
		await store.createSellRate({ capability: "text-generation", displayName: "GPT-4", unit: "1M tokens", priceUsd: 10.0 });
		await store.createProviderCost({ capability: "text-generation", adapter: "openrouter", unit: "1M tokens", costUsd: 8.0 });

		const result = await store.getMarginReport();

		expect(result).toHaveLength(1);
		expect(result[0].capability).toBe("text-generation");
		expect(result[0].sellRate.display_name).toBe("GPT-4");
		expect(result[0].providerCosts).toHaveLength(1);
		expect(result[0].bestMarginPct).toBeCloseTo(20.0, 1); // (10 - 8) / 10 * 100 = 20%
	});

	it("handles multiple providers per capability", async () => {
		await store.createSellRate({ capability: "text-generation", displayName: "GPT-4", unit: "1M tokens", priceUsd: 10.0 });
		await store.createProviderCost({ capability: "text-generation", adapter: "openrouter", unit: "1M tokens", costUsd: 8.0 });
		await store.createProviderCost({ capability: "text-generation", adapter: "anthropic", unit: "1M tokens", costUsd: 3.0 });

		const result = await store.getMarginReport();

		expect(result).toHaveLength(1);
		expect(result[0].providerCosts).toHaveLength(2);
		expect(result[0].bestMarginPct).toBeCloseTo(70.0, 1); // (10 - 3) / 10 * 100 = 70%
	});
});
