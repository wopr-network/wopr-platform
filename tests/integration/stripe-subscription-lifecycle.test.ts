import type { PGlite } from "@electric-sql/pglite";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import type { NewVpsSubscription, VpsStatus } from "../../src/fleet/repository-types.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { DrizzleWebhookSeenRepository } from "../../src/monetization/drizzle-webhook-seen-repository.js";
import { TenantCustomerRepository } from "../../src/monetization/stripe/tenant-store.js";
import type { WebhookDeps } from "../../src/monetization/stripe/webhook.js";
import { handleWebhookEvent } from "../../src/monetization/stripe/webhook.js";
import { createTestDb, truncateAllTables } from "../../src/test/db.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const isRealKey = STRIPE_SECRET_KEY.startsWith("sk_test_");

// Recurring prices for subscription tests (created in Stripe test mode).
// These are distinct from the one-time credit prices in .env.
const PRICE_LOW = "price_1T4Q1hB8WYGBr2WGTgYKgBvc"; // $5/mo recurring
const PRICE_HIGH = "price_1T7pdTB8WYGBr2WGfOFbNwUr"; // $100/mo recurring

const canRun = isRealKey;

function makeStripe(): Stripe {
	return new Stripe(STRIPE_SECRET_KEY);
}

/** Build a synthetic Stripe event for passing to handleWebhookEvent. */
function syntheticEvent(type: string, object: unknown): Stripe.Event {
	return {
		id: `evt_test_${type.replace(/\./g, "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		object: "event",
		type,
		api_version: null,
		created: Math.floor(Date.now() / 1000),
		livemode: false,
		pending_webhooks: 0,
		request: null,
		data: {
			object: object as Stripe.Event.Data.Object,
			previous_attributes: undefined,
		},
	} as unknown as Stripe.Event;
}

/** Minimal mock of IVpsRepository for capturing calls. */
function mockVpsRepo(existing?: { botId: string; tenantId: string; stripeSubscriptionId: string; stripeCustomerId: string; status: string }) {
	const creates: NewVpsSubscription[] = [];
	const updates: Array<{ botId: string; status: VpsStatus }> = [];
	return {
		creates,
		updates,
		repo: {
			getByBotId: async () => existing ?? null,
			getBySubscriptionId: async () => null,
			listByTenant: async () => [],
			create: async (row: NewVpsSubscription) => { creates.push(row); },
			updateStatus: async (botId: string, status: VpsStatus) => { updates.push({ botId, status }); },
			setSshPublicKey: async () => {},
			setTunnelId: async () => {},
			delete: async () => {},
			deleteAllByTenant: async () => {},
		},
	};
}

describe.skipIf(!canRun)("Stripe subscription lifecycle (real API)", () => {
	let stripe: Stripe;
	let db: DrizzleDb;
	let pool: PGlite;
	let tenantRepo: TenantCustomerRepository;
	let creditLedger: CreditLedger;
	let deps: WebhookDeps;

	const customersToDelete: string[] = [];

	beforeAll(async () => {
		stripe = makeStripe();
		const testDb = await createTestDb();
		pool = testDb.pool;
		db = testDb.db;
	});

	afterAll(async () => {
		await pool.close();
	});

	beforeEach(async () => {
		await truncateAllTables(pool);
		tenantRepo = new TenantCustomerRepository(db);
		creditLedger = new CreditLedger(db);
		deps = {
			tenantRepo,
			creditLedger,
			replayGuard: new DrizzleWebhookSeenRepository(db),
		};
	});

	afterEach(async () => {
		for (const cusId of customersToDelete) {
			try {
				const subs = await stripe.subscriptions.list({ customer: cusId, status: "all" });
				for (const sub of subs.data) {
					if (sub.status !== "canceled") {
						await stripe.subscriptions.cancel(sub.id);
					}
				}
				await stripe.customers.del(cusId);
			} catch {
				// Best-effort cleanup
			}
		}
		customersToDelete.length = 0;
	});

	/** Helper: create a customer with pm_card_visa as default payment method. */
	async function createCustomerWithCard(tenant: string): Promise<Stripe.Customer> {
		const customer = await stripe.customers.create({
			name: `Test ${tenant}`,
			metadata: { wopr_tenant: tenant },
		});
		customersToDelete.push(customer.id);

		const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
		await stripe.customers.update(customer.id, {
			invoice_settings: { default_payment_method: pm.id },
		});

		return customer;
	}

	it("creates a subscription and processes the webhook event", async () => {
		const TENANT = `test-tenant-${crypto.randomUUID()}`;
		const BOT_ID = `bot-${crypto.randomUUID()}`;

		const customer = await createCustomerWithCard(TENANT);

		const subscription = await stripe.subscriptions.create({
			customer: customer.id,
			items: [{ price: PRICE_LOW }],
			metadata: {
				wopr_tenant: TENANT,
				wopr_bot_id: BOT_ID,
				wopr_purchase_type: "vps",
			},
		});

		expect(subscription.status).toBe("active");

		const mock = mockVpsRepo();
		deps.vpsRepo = mock.repo;

		const result = await handleWebhookEvent(deps, syntheticEvent("customer.subscription.created", subscription));

		expect(result.handled).toBe(true);
		expect(result.event_type).toBe("customer.subscription.created");
		expect(result.tenant).toBe(TENANT);
		expect(mock.creates).toHaveLength(1);
		expect(mock.creates[0].botId).toBe(BOT_ID);
		expect(mock.creates[0].stripeSubscriptionId).toBe(subscription.id);

		const mapping = await tenantRepo.getByTenant(TENANT);
		expect(mapping).not.toBeNull();
		expect(mapping!.processor_customer_id).toBe(customer.id);
	}, 30_000);

	it("upgrades a subscription and processes the updated event", async () => {
		const TENANT = `test-tenant-${crypto.randomUUID()}`;
		const BOT_ID = `bot-${crypto.randomUUID()}`;

		const customer = await createCustomerWithCard(TENANT);

		const subscription = await stripe.subscriptions.create({
			customer: customer.id,
			items: [{ price: PRICE_LOW }],
			metadata: { wopr_tenant: TENANT, wopr_bot_id: BOT_ID, wopr_purchase_type: "vps" },
		});

		const updated = await stripe.subscriptions.update(subscription.id, {
			items: [{ id: subscription.items.data[0].id, price: PRICE_HIGH }],
			proration_behavior: "create_prorations",
		});

		expect(updated.items.data[0].price.id).toBe(PRICE_HIGH);

		const mock = mockVpsRepo({
			botId: BOT_ID,
			tenantId: TENANT,
			stripeSubscriptionId: subscription.id,
			stripeCustomerId: customer.id,
			status: "active",
		});
		deps.vpsRepo = mock.repo;

		const result = await handleWebhookEvent(deps, syntheticEvent("customer.subscription.updated", updated));

		expect(result.handled).toBe(true);
		expect(result.event_type).toBe("customer.subscription.updated");
		expect(result.tenant).toBe(TENANT);
	}, 30_000);

	it("downgrades via cancel_at_period_end and processes the updated event", async () => {
		const TENANT = `test-tenant-${crypto.randomUUID()}`;
		const BOT_ID = `bot-${crypto.randomUUID()}`;

		const customer = await createCustomerWithCard(TENANT);

		const subscription = await stripe.subscriptions.create({
			customer: customer.id,
			items: [{ price: PRICE_HIGH }],
			metadata: { wopr_tenant: TENANT, wopr_bot_id: BOT_ID, wopr_purchase_type: "vps" },
		});

		const updated = await stripe.subscriptions.update(subscription.id, {
			cancel_at_period_end: true,
		});

		expect(updated.cancel_at_period_end).toBe(true);

		const mock = mockVpsRepo({
			botId: BOT_ID,
			tenantId: TENANT,
			stripeSubscriptionId: subscription.id,
			stripeCustomerId: customer.id,
			status: "active",
		});
		deps.vpsRepo = mock.repo;

		const result = await handleWebhookEvent(deps, syntheticEvent("customer.subscription.updated", updated));

		expect(result.handled).toBe(true);
		expect(result.tenant).toBe(TENANT);
		// When cancel_at_period_end is true but status is still "active",
		// the handler hits the active branch first (existing != null → updateStatus("active")).
		// The "canceling" branch is only reached when status != active && != canceled.
		expect(mock.updates).toHaveLength(1);
		expect(mock.updates[0]).toEqual({ botId: BOT_ID, status: "active" });
	}, 30_000);

	it("cancels a subscription and processes the deleted event", async () => {
		const TENANT = `test-tenant-${crypto.randomUUID()}`;
		const BOT_ID = `bot-${crypto.randomUUID()}`;

		const customer = await createCustomerWithCard(TENANT);

		const subscription = await stripe.subscriptions.create({
			customer: customer.id,
			items: [{ price: PRICE_LOW }],
			metadata: { wopr_tenant: TENANT, wopr_bot_id: BOT_ID, wopr_purchase_type: "vps" },
		});

		const canceled = await stripe.subscriptions.cancel(subscription.id);
		expect(canceled.status).toBe("canceled");

		const mock = mockVpsRepo({
			botId: BOT_ID,
			tenantId: TENANT,
			stripeSubscriptionId: subscription.id,
			stripeCustomerId: customer.id,
			status: "active",
		});
		deps.vpsRepo = mock.repo;

		const result = await handleWebhookEvent(deps, syntheticEvent("customer.subscription.deleted", canceled));

		expect(result.handled).toBe(true);
		expect(result.event_type).toBe("customer.subscription.deleted");
		expect(result.tenant).toBe(TENANT);
		expect(mock.updates).toHaveLength(1);
		expect(mock.updates[0]).toEqual({ botId: BOT_ID, status: "canceled" });
	}, 30_000);

	it("handles payment failure with pm_card_chargeCustomerFail", async () => {
		const TENANT = `test-tenant-${crypto.randomUUID()}`;
		const BOT_ID = `bot-${crypto.randomUUID()}`;

		const customer = await stripe.customers.create({
			name: `Test ${TENANT}`,
			metadata: { wopr_tenant: TENANT },
		});
		customersToDelete.push(customer.id);

		const pm = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customer.id });
		await stripe.customers.update(customer.id, {
			invoice_settings: { default_payment_method: pm.id },
		});

		// Upsert tenant mapping so invoice.payment_failed can look up the tenant
		await tenantRepo.upsert({ tenant: TENANT, processorCustomerId: customer.id });

		// Subscription creation may throw if first payment fails immediately
		let subscription: Stripe.Subscription | undefined;
		try {
			subscription = await stripe.subscriptions.create({
				customer: customer.id,
				items: [{ price: PRICE_LOW }],
				metadata: { wopr_tenant: TENANT, wopr_bot_id: BOT_ID, wopr_purchase_type: "vps" },
			});
		} catch {
			// Expected — first payment fails
		}

		// Get the failed invoice for this customer
		const invoices = await stripe.invoices.list({ customer: customer.id, limit: 1 });
		const invoice = invoices.data[0];

		if (invoice) {
			const suspendedBots: string[] = [];
			deps.botBilling = {
				suspendAllForTenant: async () => {
					suspendedBots.push(BOT_ID);
					return [BOT_ID];
				},
			} as WebhookDeps["botBilling"];

			const result = await handleWebhookEvent(deps, syntheticEvent("invoice.payment_failed", invoice));

			expect(result.handled).toBe(true);
			expect(result.event_type).toBe("invoice.payment_failed");
			expect(result.tenant).toBe(TENANT);
			expect(result.suspendedBots).toContain(BOT_ID);
		}

		if (subscription) {
			try { await stripe.subscriptions.cancel(subscription.id); } catch { /* already canceled */ }
		}
	}, 30_000);
});
