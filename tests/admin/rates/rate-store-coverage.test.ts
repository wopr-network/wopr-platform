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
		store.createSellRate({
			capability: "margin-filter-1",
			displayName: "Rate 1",
			unit: "1M tokens",
			priceUsd: 10.0,
		});

		store.createProviderCost({
			capability: "margin-filter-1",
			adapter: "provider-1",
			unit: "1M tokens",
			costUsd: 8.0,
		});

		store.createSellRate({
			capability: "margin-filter-2",
			displayName: "Rate 2",
			unit: "1M tokens",
			priceUsd: 5.0,
		});

		const filtered = store.getMarginReport("margin-filter-1");
		const all = store.getMarginReport();

		expect(filtered).toHaveLength(1);
		expect(filtered[0].capability).toBe("margin-filter-1");
		expect(all.length).toBeGreaterThanOrEqual(2);
	});
});
