/**
 * E2E tests for feature-gate middleware (WOP-1753).
 *
 * Verifies that createFeatureGate middleware blocks zero-balance tenants
 * and unblocks after credit purchase, using real Hono app + PGlite + real ledger.
 */
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { Credit } from "@wopr-network/platform-core";
import { createFeatureGate } from "@wopr-network/platform-core/monetization/feature-gate";
import { createTestDb } from "@wopr-network/platform-core/test/db";

const { CreditLedger } = await import("@wopr-network/platform-core");

// biome-ignore lint/suspicious/noExplicitAny: test helper type for flexible Hono vars
type AnyEnv = { Variables: Record<string, any> };

const TENANT = "tenant-gate-test";

function createGatedApp(ledger: InstanceType<typeof CreditLedger>) {
	const { requireBalance } = createFeatureGate({
		getUserBalance: (tenantId) => ledger.balance(tenantId),
	});

	const app = new Hono<AnyEnv>();

	// Fake auth middleware — sets user from x-tenant-id header
	app.use("/*", async (c, next) => {
		const tenantId = c.req.header("x-tenant-id");
		if (tenantId) {
			c.set("user", { id: tenantId });
		}
		return next();
	});

	// Gated route
	app.post("/gated/action", requireBalance(), (c) => {
		return c.json({ ok: true });
	});

	return app;
}

describe("e2e: feature gate middleware (WOP-1753)", () => {
	let pool: PGlite;
	let db: DrizzleDb;
	let ledger: InstanceType<typeof CreditLedger>;
	let app: ReturnType<typeof createGatedApp>;

	beforeEach(async () => {
		({ db, pool } = await createTestDb());
		ledger = new CreditLedger(db);
		app = createGatedApp(ledger);
	});

	afterEach(async () => {
		await pool.close();
	});

	it("blocks request when tenant has zero balance (402)", async () => {
		const res = await app.request("/gated/action", {
			method: "POST",
			headers: { "x-tenant-id": TENANT },
		});

		expect(res.status).toBe(402);
		const body = await res.json();
		expect(body.error).toBe("Insufficient credit balance");
		expect(body.currentBalance).toBe(0);
		expect(body.purchaseUrl).toBe("/settings/billing");
	});

	it("allows request when tenant has positive balance ($5.00)", async () => {
		await ledger.credit(TENANT, Credit.fromCents(500), "purchase", "test grant");

		const res = await app.request("/gated/action", {
			method: "POST",
			headers: { "x-tenant-id": TENANT },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	it("blocks after balance drops to zero mid-session", async () => {
		await ledger.credit(TENANT, Credit.fromCents(100), "purchase", "initial");

		const res1 = await app.request("/gated/action", {
			method: "POST",
			headers: { "x-tenant-id": TENANT },
		});
		expect(res1.status).toBe(200);

		await ledger.debit(TENANT, Credit.fromCents(100), "bot_runtime", "usage");

		const res2 = await app.request("/gated/action", {
			method: "POST",
			headers: { "x-tenant-id": TENANT },
		});
		expect(res2.status).toBe(402);
		const body = await res2.json();
		expect(body.error).toBe("Insufficient credit balance");
		expect(body.currentBalance).toBe(0);
	});

	it("unblocks after purchasing credits", async () => {
		const res1 = await app.request("/gated/action", {
			method: "POST",
			headers: { "x-tenant-id": TENANT },
		});
		expect(res1.status).toBe(402);

		await ledger.credit(TENANT, Credit.fromCents(1000), "purchase", "credit purchase");

		const res2 = await app.request("/gated/action", {
			method: "POST",
			headers: { "x-tenant-id": TENANT },
		});
		expect(res2.status).toBe(200);
		const body = await res2.json();
		expect(body.ok).toBe(true);
	});
});
