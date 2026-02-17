import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createAdminRateApiRoutes } from "../../../src/api/routes/admin-rates.js";
import type { AuthEnv } from "../../../src/auth/index.js";

function createTestApp(): Hono<AuthEnv> {
	const db = new BetterSqlite3(":memory:");
	return createAdminRateApiRoutes(db);
}

describe("Admin Rate API Routes", () => {
	let app: Hono<AuthEnv>;

	beforeEach(() => {
		app = createTestApp();
	});

	describe("POST /sell - Create sell rate", () => {
		it("creates a sell rate and returns 201", async () => {
			const response = await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: 10.0,
				}),
			});

			expect(response.status).toBe(201);
			const data = await response.json();
			expect(data.capability).toBe("text-generation");
			expect(data.display_name).toBe("GPT-4");
		});

		it("returns 400 for missing required fields", async () => {
			const response = await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
				}),
			});

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toBeDefined();
		});

		it("returns 400 for negative price", async () => {
			const response = await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: -10.0,
				}),
			});

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("positive");
		});
	});

	describe("PUT /sell/:id - Update sell rate", () => {
		it("updates and returns 200", async () => {
			// Create first
			const createResponse = await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: 10.0,
				}),
			});
			const created = await createResponse.json();

			// Update
			const updateResponse = await app.request(`/sell/${created.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceUsd: 12.0 }),
			});

			expect(updateResponse.status).toBe(200);
			const updated = await updateResponse.json();
			expect(updated.price_usd).toBe(12.0);
		});

		it("returns 404 for non-existent ID", async () => {
			const response = await app.request("/sell/non-existent-id", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceUsd: 12.0 }),
			});

			expect(response.status).toBe(404);
		});
	});

	describe("DELETE /sell/:id - Delete sell rate", () => {
		it("returns 200 on successful deletion", async () => {
			// Create first
			const createResponse = await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: 10.0,
				}),
			});
			const created = await createResponse.json();

			// Delete
			const deleteResponse = await app.request(`/sell/${created.id}`, {
				method: "DELETE",
			});

			expect(deleteResponse.status).toBe(200);
			const data = await deleteResponse.json();
			expect(data.success).toBe(true);
		});

		it("returns 404 for non-existent ID", async () => {
			const response = await app.request("/sell/non-existent-id", {
				method: "DELETE",
			});

			expect(response.status).toBe(404);
		});
	});

	describe("GET / - List rates", () => {
		it("returns both sell rates and provider costs", async () => {
			// Create sell rate
			await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: 10.0,
				}),
			});

			// Create provider cost
			await app.request("/provider", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					adapter: "openrouter",
					unit: "1M tokens",
					costUsd: 8.0,
				}),
			});

			const response = await app.request("/", { method: "GET" });

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.sell_rates).toHaveLength(1);
			expect(data.provider_costs).toHaveLength(1);
		});

		it("filters by capability query param", async () => {
			// Create two sell rates with different capabilities
			await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: 10.0,
				}),
			});

			await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "tts",
					displayName: "TTS",
					unit: "1K chars",
					priceUsd: 0.2,
				}),
			});

			const response = await app.request("/?capability=tts", { method: "GET" });

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.sell_rates).toHaveLength(1);
			expect(data.sell_rates[0].capability).toBe("tts");
		});
	});

	describe("POST /provider - Create provider cost", () => {
		it("creates a provider cost and returns 201", async () => {
			const response = await app.request("/provider", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					adapter: "openrouter",
					unit: "1M tokens",
					costUsd: 8.0,
				}),
			});

			expect(response.status).toBe(201);
			const data = await response.json();
			expect(data.capability).toBe("text-generation");
			expect(data.adapter).toBe("openrouter");
			expect(data.latency_class).toBe("standard");
		});

		it("returns 400 for missing required fields", async () => {
			const response = await app.request("/provider", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
				}),
			});

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toBeDefined();
		});
	});

	describe("PUT /provider/:id - Update provider cost", () => {
		it("updates and returns 200", async () => {
			// Create first
			const createResponse = await app.request("/provider", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					adapter: "openrouter",
					unit: "1M tokens",
					costUsd: 8.0,
				}),
			});
			const created = await createResponse.json();

			// Update
			const updateResponse = await app.request(`/provider/${created.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ costUsd: 9.0 }),
			});

			expect(updateResponse.status).toBe(200);
			const updated = await updateResponse.json();
			expect(updated.cost_usd).toBe(9.0);
		});

		it("returns 404 for non-existent ID", async () => {
			const response = await app.request("/provider/non-existent-id", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ costUsd: 9.0 }),
			});

			expect(response.status).toBe(404);
		});
	});

	describe("DELETE /provider/:id - Delete provider cost", () => {
		it("returns 200 on successful deletion", async () => {
			// Create first
			const createResponse = await app.request("/provider", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					adapter: "openrouter",
					unit: "1M tokens",
					costUsd: 8.0,
				}),
			});
			const created = await createResponse.json();

			// Delete
			const deleteResponse = await app.request(`/provider/${created.id}`, {
				method: "DELETE",
			});

			expect(deleteResponse.status).toBe(200);
			const data = await deleteResponse.json();
			expect(data.success).toBe(true);
		});

		it("returns 404 for non-existent ID", async () => {
			const response = await app.request("/provider/non-existent-id", {
				method: "DELETE",
			});

			expect(response.status).toBe(404);
		});
	});

	describe("GET /margins - Margin report", () => {
		it("returns margin report", async () => {
			// Create sell rate
			await app.request("/sell", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					displayName: "GPT-4",
					unit: "1M tokens",
					priceUsd: 10.0,
				}),
			});

			// Create provider cost
			await app.request("/provider", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					capability: "text-generation",
					adapter: "openrouter",
					unit: "1M tokens",
					costUsd: 8.0,
				}),
			});

			const response = await app.request("/margins", { method: "GET" });

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.margins).toHaveLength(1);
			expect(data.margins[0].capability).toBe("text-generation");
			expect(data.margins[0].bestMarginPct).toBeCloseTo(20.0, 1);
		});
	});
});
