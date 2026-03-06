import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

const REQUIRED_PRICE_VARS = [
	"STRIPE_CREDIT_PRICE_5",
	"STRIPE_CREDIT_PRICE_10",
	"STRIPE_CREDIT_PRICE_25",
	"STRIPE_CREDIT_PRICE_50",
	"STRIPE_CREDIT_PRICE_100",
] as const;

const hasAllStripeConfig =
	STRIPE_SECRET_KEY.startsWith("sk_test_") &&
	STRIPE_WEBHOOK_SECRET.length > 0 &&
	REQUIRED_PRICE_VARS.every((v) => process.env[v]);

// Track resources for cleanup
const createdCustomerIds: string[] = [];

describe.skipIf(!hasAllStripeConfig)(
	"Stripe API integration (real test-mode calls)",
	() => {
		// Defer construction so file loads without error when key is absent
		const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : (undefined as unknown as Stripe);

		afterEach(async () => {
			for (const id of createdCustomerIds) {
				try {
					await stripe.customers.del(id);
				} catch {
					// Ignore — may already be deleted
				}
			}
			createdCustomerIds.length = 0;
		});

		it("creates a checkout session with a real price ID", async () => {
			const priceId = process.env.STRIPE_CREDIT_PRICE_5!;

			const customer = await stripe.customers.create({
				metadata: { wopr_test: "stripe-api-integration" },
			});
			createdCustomerIds.push(customer.id);

			const session = await stripe.checkout.sessions.create({
				mode: "payment",
				customer: customer.id,
				line_items: [{ price: priceId!, quantity: 1 }],
				success_url: "https://example.com/success",
				cancel_url: "https://example.com/cancel",
				client_reference_id: "integration-test-tenant",
				metadata: {
					wopr_tenant: "integration-test-tenant",
					wopr_purchase_type: "credits",
				},
			});

			expect(session.id).toMatch(/^cs_test_/);
			expect(session.url).toBeTruthy();
			expect(typeof session.url).toBe("string");
			expect(session.client_reference_id).toBe("integration-test-tenant");
			expect(session.metadata?.wopr_purchase_type).toBe("credits");
		});

		it("creates and retrieves a Stripe customer", async () => {
			const customer = await stripe.customers.create({
				email: "integration-test@wopr.network",
				metadata: { wopr_test: "stripe-api-integration", wopr_tenant: "test-tenant-1736" },
			});
			createdCustomerIds.push(customer.id);

			expect(customer.id).toMatch(/^cus_/);
			expect(customer.email).toBe("integration-test@wopr.network");
			expect(customer.metadata.wopr_tenant).toBe("test-tenant-1736");

			const retrieved = await stripe.customers.retrieve(customer.id);
			expect(retrieved.id).toBe(customer.id);
			expect((retrieved as Stripe.Customer).email).toBe("integration-test@wopr.network");
		});

		it("attaches a payment method via SetupIntent confirmation", async () => {
			const customer = await stripe.customers.create({
				metadata: { wopr_test: "stripe-api-integration" },
			});
			createdCustomerIds.push(customer.id);

			const setupIntent = await stripe.setupIntents.create({
				customer: customer.id,
				payment_method_types: ["card"],
				metadata: { wopr_tenant: "test-tenant-1736" },
			});

			expect(setupIntent.id).toMatch(/^seti_/);
			expect(setupIntent.client_secret).toBeTruthy();

			const confirmed = await stripe.setupIntents.confirm(setupIntent.id, {
				payment_method: "pm_card_visa",
			});

			expect(confirmed.status).toBe("succeeded");
			expect(confirmed.payment_method).toBeTruthy();

			const methods = await stripe.customers.listPaymentMethods(customer.id, {
				type: "card",
			});
			expect(methods.data.length).toBeGreaterThanOrEqual(1);
			expect(methods.data.some((m) => m.card?.last4 === "4242")).toBe(true);
		});

		it("creates a billing portal session with a valid redirect URL", async () => {
			const customer = await stripe.customers.create({
				metadata: { wopr_test: "stripe-api-integration" },
			});
			createdCustomerIds.push(customer.id);

			const portalSession = await stripe.billingPortal.sessions.create({
				customer: customer.id,
				return_url: "https://wopr.network/billing",
			});

			expect(portalSession.id).toMatch(/^bps_/);
			expect(portalSession.url).toBeTruthy();
			expect(portalSession.url).toContain("billing.stripe.com");
			expect(portalSession.return_url).toBe("https://wopr.network/billing");
		});

		it("verifies webhook signatures with the real webhook secret", () => {
			const payload = JSON.stringify({
				id: "evt_test_integration",
				type: "checkout.session.completed",
				data: { object: { id: "cs_test_fake" } },
			});
			const timestamp = Math.floor(Date.now() / 1000);

			const signature = stripe.webhooks.generateTestHeaderString({
				payload,
				secret: STRIPE_WEBHOOK_SECRET,
				timestamp,
			});

			const event = stripe.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
			expect(event.id).toBe("evt_test_integration");
			expect(event.type).toBe("checkout.session.completed");

			expect(() => {
				stripe.webhooks.constructEvent(payload, "t=0,v1=bad_signature", STRIPE_WEBHOOK_SECRET);
			}).toThrow();
		});

		it("validates all STRIPE_CREDIT_PRICE_* env vars resolve to active prices", async () => {
			const expectedAmounts = [500, 1000, 2500, 5000, 10000];

			for (let i = 0; i < REQUIRED_PRICE_VARS.length; i++) {
				const priceId = process.env[REQUIRED_PRICE_VARS[i]]!;

				const price = await stripe.prices.retrieve(priceId);
				expect(price.active, `${REQUIRED_PRICE_VARS[i]} (${priceId}) must be active`).toBe(true);
				expect(price.unit_amount, `${REQUIRED_PRICE_VARS[i]} amount mismatch`).toBe(expectedAmounts[i]);
				expect(price.currency).toBe("usd");
			}
		});
	},
);
