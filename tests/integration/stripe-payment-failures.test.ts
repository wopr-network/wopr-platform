import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const canRun =
  process.env.RUN_STRIPE_REAL_INTEGRATION_TESTS === "1" &&
  process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") === true;

describe.skipIf(!canRun)(
	"Stripe payment failure handling (real test-mode calls)",
	() => {
		const stripe = STRIPE_SECRET_KEY
			? new Stripe(STRIPE_SECRET_KEY)
			: (undefined as unknown as Stripe);

		// Track PaymentIntent IDs for cleanup
		const createdPaymentIntentIds: string[] = [];

		afterEach(async () => {
			for (const piId of createdPaymentIntentIds) {
				try {
					await stripe.paymentIntents.cancel(piId);
				} catch {
					// Ignore — may already be in a terminal state
				}
			}
			createdPaymentIntentIds.length = 0;
		});

		/** Helper: attempt a PaymentIntent with a test token that we expect to fail. */
		async function expectPaymentIntentFailure(
			cardToken: string,
		): Promise<Stripe.errors.StripeCardError> {
			try {
				const pi = await stripe.paymentIntents.create({
					amount: 500,
					currency: "usd",
					payment_method_data: { type: "card", card: { token: cardToken } },
					confirm: true,
					return_url: "https://example.com/return",
					metadata: { test: "true", testSuite: "stripe-payment-failures" },
				});
				createdPaymentIntentIds.push(pi.id);
				throw new Error("Expected PaymentIntent to fail but it succeeded");
			} catch (err) {
				if (!(err instanceof Stripe.errors.StripeCardError)) throw err;
				if (err.payment_intent?.id) {
					createdPaymentIntentIds.push(err.payment_intent.id);
				}
				return err;
			}
		}

		it("rejects a generic declined card (tok_chargeDeclined)", async () => {
			const err = await expectPaymentIntentFailure("tok_chargeDeclined");

			expect(err.type).toBe("card_error");
			expect(err.code).toBe("card_declined");
			expect(err.decline_code).toBe("generic_decline");
			expect(err.statusCode).toBe(402);
		}, 30_000);

		it("rejects insufficient funds (tok_chargeDeclinedInsufficientFunds)", async () => {
			const err = await expectPaymentIntentFailure(
				"tok_chargeDeclinedInsufficientFunds",
			);

			expect(err.type).toBe("card_error");
			expect(err.code).toBe("card_declined");
			expect(err.decline_code).toBe("insufficient_funds");
			expect(err.statusCode).toBe(402);
		}, 30_000);

		it("rejects an expired card (tok_chargeDeclinedExpiredCard)", async () => {
			const err = await expectPaymentIntentFailure(
				"tok_chargeDeclinedExpiredCard",
			);

			expect(err.type).toBe("card_error");
			expect(err.code).toBe("expired_card");
			expect(err.decline_code).toBe("expired_card");
			expect(err.statusCode).toBe(402);
		}, 30_000);

		it("rejects with processing error (tok_chargeDeclinedProcessingError)", async () => {
			const err = await expectPaymentIntentFailure(
				"tok_chargeDeclinedProcessingError",
			);

			expect(err.type).toBe("card_error");
			expect(err.code).toBe("processing_error");
			expect(err.decline_code).toBe("processing_error");
			expect(err.statusCode).toBe(402);
		}, 30_000);

		it("detects CVC check failure (tok_cvcCheckFail)", async () => {
			// CVC-fail cards succeed the charge but report cvc_check as "fail"
			const pi = await stripe.paymentIntents.create({
				amount: 500,
				currency: "usd",
				payment_method_data: { type: "card", card: { token: "tok_cvcCheckFail" } },
				confirm: true,
				return_url: "https://example.com/return",
				expand: ["latest_charge"],
				metadata: { test: "true", testSuite: "stripe-payment-failures" },
			});
			createdPaymentIntentIds.push(pi.id);

			expect(pi.status).toBe("succeeded");

			const charge = pi.latest_charge;
			expect(charge).toBeTruthy();

			const fullCharge =
				typeof charge === "string"
					? await stripe.charges.retrieve(charge)
					: (charge as Stripe.Charge);

			const cvcCheck =
				fullCharge.payment_method_details?.card?.checks?.cvc_check;
			expect(cvcCheck).toBe("fail");
		}, 30_000);

		it("error shape includes type, code, and statusCode on all card errors", async () => {
			const err = await expectPaymentIntentFailure("tok_chargeDeclined");

			// Validate the full error shape that our codebase relies on
			// (see src/monetization/credits/auto-topup-charge.ts)
			expect(err).toHaveProperty("type");
			expect(err).toHaveProperty("code");
			expect(err).toHaveProperty("statusCode");
			expect(err).toHaveProperty("message");
			expect(typeof err.type).toBe("string");
			expect(typeof err.code).toBe("string");
			expect(typeof err.statusCode).toBe("number");
			expect(typeof err.message).toBe("string");
			// decline_code can be string or undefined depending on error type
			expect(
				typeof err.decline_code === "string" || err.decline_code === undefined,
			).toBe(true);
		}, 30_000);
	},
);
