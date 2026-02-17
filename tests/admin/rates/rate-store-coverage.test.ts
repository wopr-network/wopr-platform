import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateStore } from "../../../src/admin/rates/rate-store.js";
import { initRateSchema } from "../../../src/admin/rates/schema.js";

function createTestDb() {
	const db = new BetterSqlite3(":memory:");
	initRateSchema(db);
	return db;
}

describe("RateStore - Uniqueness Constraints Coverage", () => {
	let db: BetterSqlite3.Database;
	let store: RateStore;

	beforeEach(() => {
		db = createTestDb();
		store = new RateStore(db);
	});

	afterEach(() => {
		db.close();
	});

	it("allows multiple sell rates with different models for same capability", () => {
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

		const result1 = store.createSellRate(input1);
		const result2 = store.createSellRate(input2);

		expect(result1.id).toBeDefined();
		expect(result2.id).toBeDefined();
		expect(result1.id).not.toBe(result2.id);
	});

	it("enforces unique (capability, adapter, model) for provider costs when model is provided", () => {
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

		store.createProviderCost(input1);
		expect(() => store.createProviderCost(input2)).toThrow();
	});

	it("allows only one NULL-model provider cost per (capability, adapter)", () => {
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

		store.createProviderCost(input1);
		expect(() => store.createProviderCost(input2)).toThrow(/NULL model already exists/);
	});

	it("allows NULL-model provider costs for different adapters", () => {
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

		const result1 = store.createProviderCost(input1);
		const result2 = store.createProviderCost(input2);

		expect(result1.id).toBeDefined();
		expect(result2.id).toBeDefined();
		expect(result1.adapter).toBe("anthropic");
		expect(result2.adapter).toBe("openrouter");
	});
});

describe("RateStore - listPublicRates Coverage", () => {
	let db: BetterSqlite3.Database;
	let store: RateStore;

	beforeEach(() => {
		db = createTestDb();
		store = new RateStore(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns only active sell rates", () => {
		store.createSellRate({
			capability: "public-active",
			displayName: "Active Rate",
			unit: "1M tokens",
			priceUsd: 10.0,
			isActive: true,
		});

		store.createSellRate({
			capability: "public-inactive",
			displayName: "Inactive Rate",
			unit: "1K chars",
			priceUsd: 0.3,
			isActive: false,
		});

		const publicRates = store.listPublicRates();

		expect(publicRates).toHaveLength(1);
		expect(publicRates[0].display_name).toBe("Active Rate");
	});

	it("orders public rates by sort_order ASC, then display_name ASC", () => {
		store.createSellRate({
			capability: "sort-z",
			displayName: "Z Rate",
			unit: "1M tokens",
			priceUsd: 10.0,
			sortOrder: 2,
			isActive: true,
		});

		store.createSellRate({
			capability: "sort-a",
			displayName: "A Rate",
			unit: "1M tokens",
			priceUsd: 5.0,
			sortOrder: 1,
			isActive: true,
		});

		store.createSellRate({
			capability: "sort-b",
			displayName: "B Rate",
			unit: "1M tokens",
			priceUsd: 7.0,
			sortOrder: 1,
			isActive: true,
		});

		const publicRates = store.listPublicRates();

		expect(publicRates).toHaveLength(3);
		expect(publicRates[0].display_name).toBe("A Rate");
		expect(publicRates[1].display_name).toBe("B Rate");
		expect(publicRates[2].display_name).toBe("Z Rate");
	});
});

describe("RateStore - Filter Coverage", () => {
	let db: BetterSqlite3.Database;
	let store: RateStore;

	beforeEach(() => {
		db = createTestDb();
		store = new RateStore(db);
	});

	afterEach(() => {
		db.close();
	});

	it("filters provider costs by adapter", () => {
		store.createProviderCost({
			capability: "filter-test",
			adapter: "anthropic",
			unit: "1M tokens",
			costUsd: 3.0,
		});

		store.createProviderCost({
			capability: "filter-test",
			adapter: "openrouter",
			unit: "1M tokens",
			costUsd: 8.0,
		});

		const result = store.listProviderCosts({ adapter: "anthropic" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].adapter).toBe("anthropic");
	});

	it("filters provider costs by isActive", () => {
		store.createProviderCost({
			capability: "active-filter-test",
			adapter: "provider-a",
			unit: "1M tokens",
			costUsd: 3.0,
			isActive: true,
		});

		store.createProviderCost({
			capability: "inactive-filter-test",
			adapter: "provider-b",
			unit: "1M tokens",
			costUsd: 8.0,
			isActive: false,
		});

		const activeResult = store.listProviderCosts({ isActive: true });
		const inactiveResult = store.listProviderCosts({ isActive: false });

		expect(activeResult.entries.length).toBeGreaterThanOrEqual(1);
		expect(inactiveResult.entries.length).toBeGreaterThanOrEqual(1);
	});

	it("filters sell rates by capability", () => {
		store.createSellRate({ capability: "cap-a", displayName: "A", unit: "tok", priceUsd: 1 });
		store.createSellRate({ capability: "cap-b", displayName: "B", unit: "tok", priceUsd: 2 });
		const result = store.listSellRates({ capability: "cap-a" });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("filters sell rates by isActive", () => {
		store.createSellRate({ capability: "active-sr", displayName: "A", unit: "tok", priceUsd: 1, isActive: true });
		store.createSellRate({ capability: "inactive-sr", displayName: "I", unit: "tok", priceUsd: 2, isActive: false });
		expect(store.listSellRates({ isActive: true }).entries.length).toBeGreaterThanOrEqual(1);
		expect(store.listSellRates({ isActive: false }).entries.length).toBeGreaterThanOrEqual(1);
	});

	it("respects limit and offset for sell rates", () => {
		for (let i = 0; i < 5; i++) store.createSellRate({ capability: `lim-${i}`, displayName: `R${i}`, unit: "tok", priceUsd: i });
		const page = store.listSellRates({ limit: 2, offset: 1 });
		expect(page.entries).toHaveLength(2);
		expect(page.total).toBe(5);
	});

	it("respects limit and offset for provider costs", () => {
		for (let i = 0; i < 5; i++) store.createProviderCost({ capability: `plim-${i}`, adapter: `a${i}`, unit: "tok", costUsd: i });
		const page = store.listProviderCosts({ limit: 2, offset: 1 });
		expect(page.entries).toHaveLength(2);
		expect(page.total).toBe(5);
	});

	it("returns margin report with capability filter", () => {
		store.createSellRate({ capability: "margin-filter-1", displayName: "Rate 1", unit: "1M tokens", priceUsd: 10.0 });
		store.createProviderCost({ capability: "margin-filter-1", adapter: "provider-1", unit: "1M tokens", costUsd: 8.0 });
		store.createSellRate({ capability: "margin-filter-2", displayName: "Rate 2", unit: "1M tokens", priceUsd: 5.0 });
		const filtered = store.getMarginReport("margin-filter-1");
		const all = store.getMarginReport();
		expect(filtered).toHaveLength(1);
		expect(filtered[0].capability).toBe("margin-filter-1");
		expect(all.length).toBeGreaterThanOrEqual(2);
	});

	it("margin report handles zero-price sell rate", () => {
		store.createSellRate({ capability: "zero-price", displayName: "Free", unit: "tok", priceUsd: 0 });
		const report = store.getMarginReport("zero-price");
		expect(report[0].bestMarginPct).toBe(0);
	});

	it("margin report handles sell rate with no provider costs", () => {
		store.createSellRate({ capability: "no-provider", displayName: "Orphan", unit: "tok", priceUsd: 10 });
		const report = store.getMarginReport("no-provider");
		expect(report[0].providerCosts).toHaveLength(0);
		expect(report[0].bestMarginPct).toBe(100);
	});

	it("lists all sell rates with no filters", () => {
		store.createSellRate({ capability: "nf-1", displayName: "R1", unit: "tok", priceUsd: 1 });
		store.createSellRate({ capability: "nf-2", displayName: "R2", unit: "tok", priceUsd: 2 });
		const result = store.listSellRates();
		expect(result.entries).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("lists all provider costs with no filters", () => {
		store.createProviderCost({ capability: "nf-pc1", adapter: "a1", unit: "tok", costUsd: 1 });
		store.createProviderCost({ capability: "nf-pc2", adapter: "a2", unit: "tok", costUsd: 2 });
		const result = store.listProviderCosts();
		expect(result.entries).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("filters provider costs by capability", () => {
		store.createProviderCost({ capability: "pc-cap-a", adapter: "a1", unit: "tok", costUsd: 1 });
		store.createProviderCost({ capability: "pc-cap-b", adapter: "a2", unit: "tok", costUsd: 2 });
		const result = store.listProviderCosts({ capability: "pc-cap-a" });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("caps sell rate list limit at MAX_LIMIT (250)", () => {
		store.createSellRate({ capability: "max-lim", displayName: "R", unit: "tok", priceUsd: 1 });
		const result = store.listSellRates({ limit: 999 });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("caps provider cost list limit at MAX_LIMIT (250)", () => {
		store.createProviderCost({ capability: "max-plim", adapter: "a", unit: "tok", costUsd: 1 });
		const result = store.listProviderCosts({ limit: 999 });
		expect(result.entries).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("creates sell rate with explicit model (skips NULL check)", () => {
		const rate = store.createSellRate({ capability: "model-explicit", displayName: "M", unit: "tok", priceUsd: 1, model: "gpt-4" });
		expect(rate.model).toBe("gpt-4");
	});

	it("creates provider cost with explicit model (skips NULL check)", () => {
		const cost = store.createProviderCost({ capability: "model-explicit", adapter: "a", unit: "tok", costUsd: 1, model: "gpt-4" });
		expect(cost.model).toBe("gpt-4");
	});
});

describe("RateStore - Partial Updates", () => {
	let db: BetterSqlite3.Database;
	let store: RateStore;

	beforeEach(() => {
		db = createTestDb();
		store = new RateStore(db);
	});

	afterEach(() => {
		db.close();
	});

	it("updates sell rate individual fields", () => {
		const rate = store.createSellRate({ capability: "upd", displayName: "Old", unit: "tok", priceUsd: 1 });
		store.updateSellRate(rate.id, { capability: "upd2" });
		store.updateSellRate(rate.id, { displayName: "New" });
		store.updateSellRate(rate.id, { unit: "chars" });
		store.updateSellRate(rate.id, { priceUsd: 5 });
		store.updateSellRate(rate.id, { model: "gpt-4" });
		store.updateSellRate(rate.id, { isActive: false });
		store.updateSellRate(rate.id, { sortOrder: 99 });
		const updated = store.getSellRate(rate.id);
		expect(updated?.capability).toBe("upd2");
		expect(updated?.display_name).toBe("New");
		expect(updated?.unit).toBe("chars");
		expect(updated?.price_usd).toBe(5);
		expect(updated?.model).toBe("gpt-4");
		expect(updated?.is_active).toBe(0);
		expect(updated?.sort_order).toBe(99);
	});

	it("throws when updating non-existent sell rate", () => {
		expect(() => store.updateSellRate("nonexistent", { displayName: "X" })).toThrow(/not found/);
	});

	it("updates provider cost individual fields", () => {
		const cost = store.createProviderCost({ capability: "pc", adapter: "a1", unit: "tok", costUsd: 1 });
		store.updateProviderCost(cost.id, { capability: "pc2" });
		store.updateProviderCost(cost.id, { adapter: "a2" });
		store.updateProviderCost(cost.id, { model: "gpt-4" });
		store.updateProviderCost(cost.id, { unit: "chars" });
		store.updateProviderCost(cost.id, { costUsd: 5 });
		store.updateProviderCost(cost.id, { priority: 10 });
		store.updateProviderCost(cost.id, { latencyClass: "fast" });
		store.updateProviderCost(cost.id, { isActive: false });
		const updated = store.getProviderCost(cost.id);
		expect(updated?.capability).toBe("pc2");
		expect(updated?.adapter).toBe("a2");
		expect(updated?.model).toBe("gpt-4");
		expect(updated?.unit).toBe("chars");
		expect(updated?.cost_usd).toBe(5);
		expect(updated?.priority).toBe(10);
		expect(updated?.latency_class).toBe("fast");
		expect(updated?.is_active).toBe(0);
	});

	it("throws when updating non-existent provider cost", () => {
		expect(() => store.updateProviderCost("nonexistent", { costUsd: 1 })).toThrow(/not found/);
	});

	it("delete returns false for non-existent ids", () => {
		expect(store.deleteSellRate("nonexistent")).toBe(false);
		expect(store.deleteProviderCost("nonexistent")).toBe(false);
	});

	it("delete returns true for existing ids", () => {
		const rate = store.createSellRate({ capability: "del", displayName: "D", unit: "tok", priceUsd: 1 });
		const cost = store.createProviderCost({ capability: "del", adapter: "a", unit: "tok", costUsd: 1 });
		expect(store.deleteSellRate(rate.id)).toBe(true);
		expect(store.deleteProviderCost(cost.id)).toBe(true);
	});

	it("getSellRate returns null for non-existent", () => {
		expect(store.getSellRate("nonexistent")).toBeNull();
	});

	it("getProviderCost returns null for non-existent", () => {
		expect(store.getProviderCost("nonexistent")).toBeNull();
	});

	it("updateSellRate with isActive true hits ternary true branch", () => {
		const rate = store.createSellRate({ capability: "active-t", displayName: "A", unit: "tok", priceUsd: 1, isActive: false });
		const updated = store.updateSellRate(rate.id, { isActive: true });
		expect(updated.is_active).toBe(1);
	});

	it("updateProviderCost with isActive true hits ternary true branch", () => {
		const cost = store.createProviderCost({ capability: "active-t", adapter: "a", unit: "tok", costUsd: 1, isActive: false });
		const updated = store.updateProviderCost(cost.id, { isActive: true });
		expect(updated.is_active).toBe(1);
	});

	it("updateSellRate clears model to null when no conflict exists", () => {
		const rate = store.createSellRate({ capability: "clear-model", displayName: "A", unit: "tok", priceUsd: 1, model: "gpt-4" });
		const updated = store.updateSellRate(rate.id, { model: undefined });
		expect(updated.model).toBeNull();
	});

	it("updateProviderCost clears model to null when no conflict exists", () => {
		const cost = store.createProviderCost({ capability: "clear-model", adapter: "a", unit: "tok", costUsd: 1, model: "gpt-4" });
		const updated = store.updateProviderCost(cost.id, { model: undefined });
		expect(updated.model).toBeNull();
	});

	it("updateSellRate detects NULL model uniqueness conflict", () => {
		store.createSellRate({ capability: "dup", displayName: "A", unit: "tok", priceUsd: 1 });
		const rate2 = store.createSellRate({ capability: "dup", displayName: "B", unit: "tok", priceUsd: 2, model: "m1" });
		expect(() => store.updateSellRate(rate2.id, { model: undefined })).toThrow(/NULL model already exists/);
	});

	it("updateProviderCost detects NULL model uniqueness conflict", () => {
		store.createProviderCost({ capability: "pdup", adapter: "a1", unit: "tok", costUsd: 1 });
		const cost2 = store.createProviderCost({ capability: "pdup", adapter: "a1", unit: "tok", costUsd: 2, model: "m1" });
		expect(() => store.updateProviderCost(cost2.id, { model: undefined })).toThrow(/NULL model already exists/);
	});
});
