import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateStore } from "../../../src/admin/rates/rate-store.js";
import type { DrizzleDb } from "../../../src/db/index.js";
import { createTestDb } from "../../../src/test/db.js";

describe("RateStore - Uniqueness Constraints Coverage", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeEach(async () => {
		({ db, pool } = await createTestDb());
		store = new RateStore(db);
	});

	afterEach(async () => {
		await pool.close();
	});

	it("allows multiple sell rates with different models for same capability", async () => {
		const input1 = {
			capability: "multi-model-test",
			displayName: "GPT-4",
			unit: "1M tokens",
			priceUsd: 10.0,
			model: "gpt-4",
		};

		const input2 = {
			capability: "multi-model-test",
			displayName: "GPT-3.5",
			unit: "1M tokens",
			priceUsd: 2.0,
			model: "gpt-3.5-turbo",
		};

		const result1 = await store.createSellRate(input1);
		const result2 = await store.createSellRate(input2);

		expect(result1.id).toBeDefined();
		expect(result2.id).toBeDefined();
		expect(result1.id).not.toBe(result2.id);
	});

	it("enforces unique (capability, adapter, model) for provider costs when model is provided", async () => {
		const input1 = {
			capability: "provider-unique-test",
			adapter: "openrouter",
			model: "gpt-4",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const input2 = {
			capability: "provider-unique-test",
			adapter: "openrouter",
			model: "gpt-4",
			unit: "1M tokens",
			costUsd: 9.0,
		};

		await store.createProviderCost(input1);
		await expect(store.createProviderCost(input2)).rejects.toThrow();
	});

	it("allows only one NULL-model provider cost per (capability, adapter)", async () => {
		const input1 = {
			capability: "provider-null-test",
			adapter: "anthropic",
			unit: "1M tokens",
			costUsd: 3.0,
		};

		const input2 = {
			capability: "provider-null-test",
			adapter: "anthropic",
			unit: "1M tokens",
			costUsd: 4.0,
		};

		await store.createProviderCost(input1);
		await expect(store.createProviderCost(input2)).rejects.toThrow(/NULL model already exists/);
	});

	it("allows NULL-model provider costs for different adapters", async () => {
		const input1 = {
			capability: "multi-adapter-test",
			adapter: "anthropic",
			unit: "1M tokens",
			costUsd: 3.0,
		};

		const input2 = {
			capability: "multi-adapter-test",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		};

		const result1 = await store.createProviderCost(input1);
		const result2 = await store.createProviderCost(input2);

		expect(result1.id).toBeDefined();
		expect(result2.id).toBeDefined();
		expect(result1.adapter).toBe("anthropic");
		expect(result2.adapter).toBe("openrouter");
	});
});

describe("RateStore - listPublicRates Coverage", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeEach(async () => {
		({ db, pool } = await createTestDb());
		store = new RateStore(db);
	});

	afterEach(async () => {
		await pool.close();
	});

	it("returns only active sell rates", async () => {
		await store.createSellRate({
			capability: "public-active",
			displayName: "Active Rate",
			unit: "1M tokens",
			priceUsd: 10.0,
			isActive: true,
		});

		await store.createSellRate({
			capability: "public-inactive",
			displayName: "Inactive Rate",
			unit: "1K chars",
			priceUsd: 0.3,
			isActive: false,
		});

		const publicRates = await store.listPublicRates();

		expect(publicRates).toHaveLength(1);
		expect(publicRates[0].display_name).toBe("Active Rate");
	});

	it("orders public rates by sort_order ASC, then display_name ASC", async () => {
		await store.createSellRate({
			capability: "sort-z",
			displayName: "Z Rate",
			unit: "1M tokens",
			priceUsd: 10.0,
			sortOrder: 2,
			isActive: true,
		});

		await store.createSellRate({
			capability: "sort-a",
			displayName: "A Rate",
			unit: "1M tokens",
			priceUsd: 5.0,
			sortOrder: 1,
			isActive: true,
		});

		await store.createSellRate({
			capability: "sort-b",
			displayName: "B Rate",
			unit: "1M tokens",
			priceUsd: 7.0,
			sortOrder: 1,
			isActive: true,
		});

		const publicRates = await store.listPublicRates();

		expect(publicRates).toHaveLength(3);
		expect(publicRates[0].display_name).toBe("A Rate");
		expect(publicRates[1].display_name).toBe("B Rate");
		expect(publicRates[2].display_name).toBe("Z Rate");
	});
});

describe("RateStore - Filter Coverage", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeEach(async () => {
		({ db, pool } = await createTestDb());
		store = new RateStore(db);
	});

	afterEach(async () => {
		await pool.close();
	});

	it("filters provider costs by adapter", async () => {
		await store.createProviderCost({
			capability: "filter-test",
			adapter: "anthropic",
			unit: "1M tokens",
			costUsd: 3.0,
		});

		await store.createProviderCost({
			capability: "filter-test",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		});

		const result = await store.listProviderCosts({ adapter: "anthropic" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].adapter).toBe("anthropic");
	});

	it("filters provider costs by isActive", async () => {
		await store.createProviderCost({
			capability: "active-filter-test",
			adapter: "provider-a",
			unit: "1M tokens",
			costUsd: 3.0,
			isActive: true,
		});

		await store.createProviderCost({
			capability: "inactive-filter-test",
			adapter: "provider-b",
			unit: "1M tokens",
			costUsd: 8.0,
			isActive: false,
		});

		const activeResult = await store.listProviderCosts({ isActive: true });
		const inactiveResult = await store.listProviderCosts({ isActive: false });

		expect(activeResult.entries.length).toBeGreaterThanOrEqual(1);
		expect(inactiveResult.entries.length).toBeGreaterThanOrEqual(1);
	});

	it("filters sell rates by capability", async () => {
		await store.createSellRate({ capability: "cap-a", displayName: "A", unit: "tok", priceUsd: 1 });
		await store.createSellRate({ capability: "cap-b", displayName: "B", unit: "tok", priceUsd: 2 });
		const result = await store.listSellRates({ capability: "cap-a" });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("filters sell rates by isActive", async () => {
		await store.createSellRate({ capability: "active-sr", displayName: "A", unit: "tok", priceUsd: 1, isActive: true });
		await store.createSellRate({ capability: "inactive-sr", displayName: "I", unit: "tok", priceUsd: 2, isActive: false });
		expect((await store.listSellRates({ isActive: true })).entries.length).toBeGreaterThanOrEqual(1);
		expect((await store.listSellRates({ isActive: false })).entries.length).toBeGreaterThanOrEqual(1);
	});

	it("respects limit and offset for sell rates", async () => {
		for (let i = 0; i < 5; i++) await store.createSellRate({ capability: `lim-${i}`, displayName: `R${i}`, unit: "tok", priceUsd: i });
		const page = await store.listSellRates({ limit: 2, offset: 1 });
		expect(page.entries).toHaveLength(2);
		expect(page.total).toBe(5);
	});

	it("respects limit and offset for provider costs", async () => {
		for (let i = 0; i < 5; i++) await store.createProviderCost({ capability: `plim-${i}`, adapter: `a${i}`, unit: "tok", costUsd: i });
		const page = await store.listProviderCosts({ limit: 2, offset: 1 });
		expect(page.entries).toHaveLength(2);
		expect(page.total).toBe(5);
	});

	it("returns margin report with capability filter", async () => {
		await store.createSellRate({ capability: "margin-filter-1", displayName: "Rate 1", unit: "1M tokens", priceUsd: 10.0 });
		await store.createProviderCost({ capability: "margin-filter-1", adapter: "provider-1", unit: "1M tokens", costUsd: 8.0 });
		await store.createSellRate({ capability: "margin-filter-2", displayName: "Rate 2", unit: "1M tokens", priceUsd: 5.0 });
		const filtered = await store.getMarginReport("margin-filter-1");
		const all = await store.getMarginReport();
		expect(filtered).toHaveLength(1);
		expect(filtered[0].capability).toBe("margin-filter-1");
		expect(all.length).toBeGreaterThanOrEqual(2);
	});

	it("margin report handles zero-price sell rate", async () => {
		await store.createSellRate({ capability: "zero-price", displayName: "Free", unit: "tok", priceUsd: 0 });
		const report = await store.getMarginReport("zero-price");
		expect(report[0].bestMarginPct).toBe(0);
	});

	it("margin report handles sell rate with no provider costs", async () => {
		await store.createSellRate({ capability: "no-provider", displayName: "Orphan", unit: "tok", priceUsd: 10 });
		const report = await store.getMarginReport("no-provider");
		expect(report[0].providerCosts).toHaveLength(0);
		expect(report[0].bestMarginPct).toBe(100);
	});

	it("lists all sell rates with no filters", async () => {
		await store.createSellRate({ capability: "nf-1", displayName: "R1", unit: "tok", priceUsd: 1 });
		await store.createSellRate({ capability: "nf-2", displayName: "R2", unit: "tok", priceUsd: 2 });
		const result = await store.listSellRates();
		expect(result.entries).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("lists all provider costs with no filters", async () => {
		await store.createProviderCost({ capability: "nf-pc1", adapter: "a1", unit: "tok", costUsd: 1 });
		await store.createProviderCost({ capability: "nf-pc2", adapter: "a2", unit: "tok", costUsd: 2 });
		const result = await store.listProviderCosts();
		expect(result.entries).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("filters provider costs by capability", async () => {
		await store.createProviderCost({ capability: "pc-cap-a", adapter: "a1", unit: "tok", costUsd: 1 });
		await store.createProviderCost({ capability: "pc-cap-b", adapter: "a2", unit: "tok", costUsd: 2 });
		const result = await store.listProviderCosts({ capability: "pc-cap-a" });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("caps sell rate list limit at MAX_LIMIT (250)", async () => {
		await store.createSellRate({ capability: "max-lim", displayName: "R", unit: "tok", priceUsd: 1 });
		const result = await store.listSellRates({ limit: 999 });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("caps provider cost list limit at MAX_LIMIT (250)", async () => {
		await store.createProviderCost({ capability: "max-plim", adapter: "a", unit: "tok", costUsd: 1 });
		const result = await store.listProviderCosts({ limit: 999 });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("creates sell rate with explicit model (skips NULL check)", async () => {
		const rate = await store.createSellRate({ capability: "model-explicit", displayName: "M", unit: "tok", priceUsd: 1, model: "gpt-4" });
		expect(rate.model).toBe("gpt-4");
	});

	it("creates provider cost with explicit model (skips NULL check)", async () => {
		const cost = await store.createProviderCost({ capability: "model-explicit", adapter: "a", unit: "tok", costUsd: 1, model: "gpt-4" });
		expect(cost.model).toBe("gpt-4");
	});
});

describe("RateStore - Partial Updates", () => {
	let db: DrizzleDb;
	let pool: PGlite;
	let store: RateStore;

	beforeEach(async () => {
		({ db, pool } = await createTestDb());
		store = new RateStore(db);
	});

	afterEach(async () => {
		await pool.close();
	});

	it("updates sell rate individual fields", async () => {
		const rate = await store.createSellRate({ capability: "upd", displayName: "Old", unit: "tok", priceUsd: 1 });
		await store.updateSellRate(rate.id, { capability: "upd2" });
		await store.updateSellRate(rate.id, { displayName: "New" });
		await store.updateSellRate(rate.id, { unit: "chars" });
		await store.updateSellRate(rate.id, { priceUsd: 5 });
		await store.updateSellRate(rate.id, { model: "gpt-4" });
		await store.updateSellRate(rate.id, { isActive: false });
		await store.updateSellRate(rate.id, { sortOrder: 99 });
		const updated = await store.getSellRate(rate.id);
		expect(updated?.capability).toBe("upd2");
		expect(updated?.display_name).toBe("New");
		expect(updated?.unit).toBe("chars");
		expect(updated?.price_usd).toBe(5);
		expect(updated?.model).toBe("gpt-4");
		expect(updated?.is_active).toBe(0);
		expect(updated?.sort_order).toBe(99);
	});

	it("throws when updating non-existent sell rate", async () => {
		await expect(store.updateSellRate("nonexistent", { displayName: "X" })).rejects.toThrow(/not found/);
	});

	it("updates provider cost individual fields", async () => {
		const cost = await store.createProviderCost({ capability: "pc", adapter: "a1", unit: "tok", costUsd: 1 });
		await store.updateProviderCost(cost.id, { capability: "pc2" });
		await store.updateProviderCost(cost.id, { adapter: "a2" });
		await store.updateProviderCost(cost.id, { model: "gpt-4" });
		await store.updateProviderCost(cost.id, { unit: "chars" });
		await store.updateProviderCost(cost.id, { costUsd: 5 });
		await store.updateProviderCost(cost.id, { priority: 10 });
		await store.updateProviderCost(cost.id, { latencyClass: "fast" });
		await store.updateProviderCost(cost.id, { isActive: false });
		const updated = await store.getProviderCost(cost.id);
		expect(updated?.capability).toBe("pc2");
		expect(updated?.adapter).toBe("a2");
		expect(updated?.model).toBe("gpt-4");
		expect(updated?.unit).toBe("chars");
		expect(updated?.cost_usd).toBe(5);
		expect(updated?.priority).toBe(10);
		expect(updated?.latency_class).toBe("fast");
		expect(updated?.is_active).toBe(0);
	});

	it("throws when updating non-existent provider cost", async () => {
		await expect(store.updateProviderCost("nonexistent", { costUsd: 1 })).rejects.toThrow(/not found/);
	});

	it("delete returns false for non-existent ids", async () => {
		expect(await store.deleteSellRate("nonexistent")).toBe(false);
		expect(await store.deleteProviderCost("nonexistent")).toBe(false);
	});

	it("delete returns true for existing ids", async () => {
		const rate = await store.createSellRate({ capability: "del", displayName: "D", unit: "tok", priceUsd: 1 });
		const cost = await store.createProviderCost({ capability: "del", adapter: "a", unit: "tok", costUsd: 1 });
		expect(await store.deleteSellRate(rate.id)).toBe(true);
		expect(await store.deleteProviderCost(cost.id)).toBe(true);
	});

	it("getSellRate returns null for non-existent", async () => {
		expect(await store.getSellRate("nonexistent")).toBeNull();
	});

	it("getProviderCost returns null for non-existent", async () => {
		expect(await store.getProviderCost("nonexistent")).toBeNull();
	});

	it("updateSellRate with isActive true hits ternary true branch", async () => {
		const rate = await store.createSellRate({ capability: "active-t", displayName: "A", unit: "tok", priceUsd: 1, isActive: false });
		const updated = await store.updateSellRate(rate.id, { isActive: true });
		expect(updated.is_active).toBe(1);
	});

	it("updateProviderCost with isActive true hits ternary true branch", async () => {
		const cost = await store.createProviderCost({ capability: "active-t", adapter: "a", unit: "tok", costUsd: 1, isActive: false });
		const updated = await store.updateProviderCost(cost.id, { isActive: true });
		expect(updated.is_active).toBe(1);
	});

	it("updateSellRate clears model to null when no conflict exists", async () => {
		const rate = await store.createSellRate({ capability: "clear-model", displayName: "A", unit: "tok", priceUsd: 1, model: "gpt-4" });
		const updated = await store.updateSellRate(rate.id, { model: undefined });
		expect(updated.model).toBeNull();
	});

	it("updateProviderCost clears model to null when no conflict exists", async () => {
		const cost = await store.createProviderCost({ capability: "clear-model", adapter: "a", unit: "tok", costUsd: 1, model: "gpt-4" });
		const updated = await store.updateProviderCost(cost.id, { model: undefined });
		expect(updated.model).toBeNull();
	});

	it("updateSellRate detects NULL model uniqueness conflict", async () => {
		await store.createSellRate({ capability: "dup", displayName: "A", unit: "tok", priceUsd: 1 });
		const rate2 = await store.createSellRate({ capability: "dup", displayName: "B", unit: "tok", priceUsd: 2, model: "m1" });
		await expect(store.updateSellRate(rate2.id, { model: undefined })).rejects.toThrow(/NULL model already exists/);
	});

	it("updateProviderCost detects NULL model uniqueness conflict", async () => {
		await store.createProviderCost({ capability: "pdup", adapter: "a1", unit: "tok", costUsd: 1 });
		const cost2 = await store.createProviderCost({ capability: "pdup", adapter: "a1", unit: "tok", costUsd: 2, model: "m1" });
		await expect(store.updateProviderCost(cost2.id, { model: undefined })).rejects.toThrow(/NULL model already exists/);
	});
});
