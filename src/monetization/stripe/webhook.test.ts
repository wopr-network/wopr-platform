/**
 * Unit tests for Stripe webhook handler (credit purchase model, WOP-406).
 *
 * Covers checkout.session.completed crediting the ledger,
 * bonus tier application, edge cases, and unknown events.
 */
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/index.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { CREDIT_PRICE_POINTS } from "./credit-prices.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";
import type { WebhookDeps } from "./webhook.js";
import { handleWebhookEvent, WebhookReplayGuard } from "./webhook.js";

/** Initialize credit tables in the test DB. */
function initCreditSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

describe("handleWebhookEvent (credit model)", () => {
  let sqlite: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;
  let creditLedger: CreditLedger;
  let deps: WebhookDeps;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initStripeSchema(sqlite);
    initCreditSchema(sqlite);
    const db = createDb(sqlite);
    tenantStore = new TenantCustomerStore(db);
    creditLedger = new CreditLedger(db);
    deps = { tenantStore, creditLedger };
  });

  afterEach(() => {
    sqlite.close();
  });

  // ---------------------------------------------------------------------------
  // checkout.session.completed
  // ---------------------------------------------------------------------------

  describe("checkout.session.completed", () => {
    function createCheckoutEvent(overrides?: Partial<Stripe.Checkout.Session>): Stripe.Event {
      return {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_123",
            client_reference_id: "tenant-123",
            customer: "cus_abc",
            amount_total: 2500,
            metadata: {},
            ...overrides,
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
    }

    it("credits the ledger on successful checkout", () => {
      const event = createCheckoutEvent();
      const result = handleWebhookEvent(deps, event);

      expect(result).toEqual({
        handled: true,
        event_type: "checkout.session.completed",
        tenant: "tenant-123",
        creditedCents: 2500,
      });

      // Verify credits were granted
      const balance = creditLedger.balance("tenant-123");
      expect(balance).toBe(2500);
    });

    it("applies bonus tiers when priceMap is provided", () => {
      // $25 purchase -> $25.50 credit (2% bonus)
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_25", CREDIT_PRICE_POINTS[2]]]),
      };

      const event = createCheckoutEvent({ amount_total: 2500 });
      const result = handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(2550); // 2% bonus
    });

    it("applies 5% bonus for $50 purchase", () => {
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_50", CREDIT_PRICE_POINTS[3]]]),
      };

      const event = createCheckoutEvent({ amount_total: 5000 });
      const result = handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(5250); // 5% bonus
    });

    it("applies 10% bonus for $100 purchase", () => {
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_100", CREDIT_PRICE_POINTS[4]]]),
      };

      const event = createCheckoutEvent({ amount_total: 10000 });
      const result = handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(11000); // 10% bonus
    });

    it("creates tenant-to-customer mapping", () => {
      const event = createCheckoutEvent();
      handleWebhookEvent(deps, event);

      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping).not.toBeNull();
      expect(mapping?.stripe_customer_id).toBe("cus_abc");
    });

    it("handles tenant from metadata when client_reference_id is null", () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: { wopr_tenant: "tenant-from-metadata" },
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-from-metadata");

      const balance = creditLedger.balance("tenant-from-metadata");
      expect(balance).toBe(2500);
    });

    it("handles customer object instead of string", () => {
      const event = createCheckoutEvent({
        customer: { id: "cus_obj_123" } as Stripe.Customer,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping?.stripe_customer_id).toBe("cus_obj_123");
    });

    it("returns handled:false when tenant is missing", () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: {},
      });
      const result = handleWebhookEvent(deps, event);

      expect(result).toEqual({
        handled: false,
        event_type: "checkout.session.completed",
      });
    });

    it("returns handled:false when customer is missing", () => {
      const event = createCheckoutEvent({
        customer: null,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
    });

    it("returns creditedCents:0 when amount_total is 0", () => {
      const event = createCheckoutEvent({
        amount_total: 0,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("returns creditedCents:0 when amount_total is null", () => {
      const event = createCheckoutEvent({
        amount_total: null,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("handles duplicate checkout events idempotently (skips second)", () => {
      const event = createCheckoutEvent({ amount_total: 500 });

      const first = handleWebhookEvent(deps, event);
      expect(first.creditedCents).toBe(500);

      const second = handleWebhookEvent(deps, event);
      expect(second.handled).toBe(true);
      expect(second.creditedCents).toBe(0);

      // Only credited once despite duplicate webhook delivery
      const balance = creditLedger.balance("tenant-123");
      expect(balance).toBe(500);
    });

    it("grants 1:1 credits when no priceMap is provided", () => {
      const event = createCheckoutEvent({ amount_total: 1234 });
      const result = handleWebhookEvent(deps, event);

      expect(result.creditedCents).toBe(1234);
    });

    it("records the Stripe session ID in the transaction description and referenceId", () => {
      const event = createCheckoutEvent({ id: "cs_test_abc" });
      handleWebhookEvent(deps, event);

      const txns = creditLedger.history("tenant-123");
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toContain("cs_test_abc");
      expect(txns[0].type).toBe("purchase");
      expect(txns[0].referenceId).toBe("cs_test_abc");
    });
  });

  // ---------------------------------------------------------------------------
  // Replay attack prevention (WOP-476)
  // ---------------------------------------------------------------------------

  describe("replay attack prevention", () => {
    let replayGuard: WebhookReplayGuard;

    beforeEach(() => {
      replayGuard = new WebhookReplayGuard();
    });

    function createCheckoutEventWithId(eventId: string, overrides?: Partial<Stripe.Checkout.Session>): Stripe.Event {
      return {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_replay",
            client_reference_id: "tenant-replay",
            customer: "cus_replay",
            amount_total: 1000,
            metadata: {},
            ...overrides,
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
    }

    it("rejects duplicate event IDs within the TTL window", () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };
      const event = createCheckoutEventWithId("evt_test_dup_1");

      const first = handleWebhookEvent(depsWithGuard, event);
      expect(first.handled).toBe(true);
      expect(first.creditedCents).toBe(1000);
      expect(first.duplicate).toBeUndefined();

      const second = handleWebhookEvent(depsWithGuard, event);
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.creditedCents).toBeUndefined();

      // Only credited once
      const balance = creditLedger.balance("tenant-replay");
      expect(balance).toBe(1000);
    });

    it("returns idempotent 200-style response for duplicates (not error)", () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };
      const event = createCheckoutEventWithId("evt_test_idem");

      handleWebhookEvent(depsWithGuard, event);
      const replay = handleWebhookEvent(depsWithGuard, event);

      // Must return handled: true (200 OK), not an error
      expect(replay.handled).toBe(true);
      expect(replay.event_type).toBe("checkout.session.completed");
    });

    it("allows different event IDs through", () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };

      const event1 = createCheckoutEventWithId("evt_first");
      const event2 = createCheckoutEventWithId("evt_second", { id: "cs_test_second" });

      const r1 = handleWebhookEvent(depsWithGuard, event1);
      const r2 = handleWebhookEvent(depsWithGuard, event2);

      expect(r1.creditedCents).toBe(1000);
      expect(r2.creditedCents).toBe(1000);
      expect(r1.duplicate).toBeUndefined();
      expect(r2.duplicate).toBeUndefined();

      const balance = creditLedger.balance("tenant-replay");
      expect(balance).toBe(2000);
    });

    it("blocks replay of unhandled event types too", () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };
      const event = {
        id: "evt_unknown_replay",
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const first = handleWebhookEvent(depsWithGuard, event);
      expect(first.handled).toBe(false);
      expect(first.duplicate).toBeUndefined();

      const second = handleWebhookEvent(depsWithGuard, event);
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
    });

    it("works without replay guard (backwards compatible)", () => {
      // No replayGuard in deps — should work exactly as before
      const event = createCheckoutEventWithId("evt_no_guard");
      const result = handleWebhookEvent(deps, event);
      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // WebhookReplayGuard unit tests
  // ---------------------------------------------------------------------------

  describe("WebhookReplayGuard", () => {
    it("reports unseen event IDs as not duplicate", () => {
      const guard = new WebhookReplayGuard();
      expect(guard.isDuplicate("evt_new")).toBe(false);
    });

    it("reports seen event IDs as duplicate", () => {
      const guard = new WebhookReplayGuard();
      guard.markSeen("evt_seen");
      expect(guard.isDuplicate("evt_seen")).toBe(true);
    });

    it("expires entries after TTL", async () => {
      // Use a very short TTL for testing
      const guard = new WebhookReplayGuard(50);
      guard.markSeen("evt_expire");
      expect(guard.isDuplicate("evt_expire")).toBe(true);

      await new Promise((r) => setTimeout(r, 100));
      expect(guard.isDuplicate("evt_expire")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Unhandled event types
  // ---------------------------------------------------------------------------

  describe("unhandled event types", () => {
    it("returns handled:false for customer.subscription.updated", () => {
      const event = {
        type: "customer.subscription.updated",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.updated",
      });
    });

    it("returns handled:false for customer.subscription.deleted", () => {
      const event = {
        type: "customer.subscription.deleted",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.deleted",
      });
    });

    it("returns handled:false for payment_intent.succeeded", () => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "payment_intent.succeeded",
      });
    });

    it("handles unknown event type gracefully", () => {
      const event = {
        type: "wopr.custom.event",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "wopr.custom.event",
      });
    });
  });
});
