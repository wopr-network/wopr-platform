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
import { DrizzleCreditRepository } from "../../infrastructure/persistence/drizzle-credit-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
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
  let creditRepo: DrizzleCreditRepository;
  let deps: WebhookDeps;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initStripeSchema(sqlite);
    initCreditSchema(sqlite);
    const db = createDb(sqlite);
    tenantStore = new TenantCustomerStore(db);
    creditRepo = new DrizzleCreditRepository(db);
    deps = { tenantStore, creditRepo };
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

    it("credits the ledger on successful checkout", async () => {
      const event = createCheckoutEvent();
      const result = await handleWebhookEvent(deps, event);

      expect(result).toEqual({
        handled: true,
        event_type: "checkout.session.completed",
        tenant: "tenant-123",
        creditedCents: 2500,
      });

      // Verify credits were granted
      const balance = await creditRepo.getBalance(TenantId.create("tenant-123"));
      expect(balance.balance.toCents()).toBe(2500);
    });

    it("applies bonus tiers when priceMap is provided", async () => {
      // $25 purchase -> $25.50 credit (2% bonus)
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_25", CREDIT_PRICE_POINTS[2]]]),
      };

      const event = createCheckoutEvent({ amount_total: 2500 });
      const result = await handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(2550); // 2% bonus
    });

    it("applies 5% bonus for $50 purchase", async () => {
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_50", CREDIT_PRICE_POINTS[3]]]),
      };

      const event = createCheckoutEvent({ amount_total: 5000 });
      const result = await handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(5250); // 5% bonus
    });

    it("applies 10% bonus for $100 purchase", async () => {
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_100", CREDIT_PRICE_POINTS[4]]]),
      };

      const event = createCheckoutEvent({ amount_total: 10000 });
      const result = await handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(11000); // 10% bonus
    });

    it("creates tenant-to-customer mapping", async () => {
      const event = createCheckoutEvent();
      await handleWebhookEvent(deps, event);

      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping).not.toBeNull();
      expect(mapping?.stripe_customer_id).toBe("cus_abc");
    });

    it("handles tenant from metadata when client_reference_id is null", async () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: { wopr_tenant: "tenant-from-metadata" },
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-from-metadata");

      const balance = await creditRepo.getBalance(TenantId.create("tenant-from-metadata"));
      expect(balance.balance.toCents()).toBe(2500);
    });

    it("handles customer object instead of string", async () => {
      const event = createCheckoutEvent({
        customer: { id: "cus_obj_123" } as Stripe.Customer,
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping?.stripe_customer_id).toBe("cus_obj_123");
    });

    it("returns handled:false when tenant is missing", async () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: {},
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result).toEqual({
        handled: false,
        event_type: "checkout.session.completed",
      });
    });

    it("returns handled:false when customer is missing", async () => {
      const event = createCheckoutEvent({
        customer: null,
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
    });

    it("returns creditedCents:0 when amount_total is 0", async () => {
      const event = createCheckoutEvent({
        amount_total: 0,
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("returns creditedCents:0 when amount_total is null", async () => {
      const event = createCheckoutEvent({
        amount_total: null,
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("handles duplicate checkout events idempotently (skips second)", async () => {
      const event = createCheckoutEvent({ amount_total: 500 });

      const first = await handleWebhookEvent(deps, event);
      expect(first.creditedCents).toBe(500);

      const second = await handleWebhookEvent(deps, event);
      expect(second.handled).toBe(true);
      expect(second.creditedCents).toBe(0);

      // Only credited once despite duplicate webhook delivery
      const balance = await creditRepo.getBalance(TenantId.create("tenant-123"));
      expect(balance.balance.toCents()).toBe(500);
    });

    it("grants 1:1 credits when no priceMap is provided", async () => {
      const event = createCheckoutEvent({ amount_total: 1234 });
      const result = await handleWebhookEvent(deps, event);

      expect(result.creditedCents).toBe(1234);
    });

    it("records the Stripe session ID in the transaction description and referenceId", async () => {
      const event = createCheckoutEvent({ id: "cs_test_abc" });
      await handleWebhookEvent(deps, event);

      const txns = await creditRepo.getTransactionHistory(TenantId.create("tenant-123"));
      expect(txns.transactions).toHaveLength(1);
      expect(txns.transactions[0].description).toContain("cs_test_abc");
      expect(txns.transactions[0].type).toBe("purchase");
      expect(txns.transactions[0].referenceId).toBe("cs_test_abc");
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

    it("rejects duplicate event IDs within the TTL window", async () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };
      const event = createCheckoutEventWithId("evt_test_dup_1");

      const first = await handleWebhookEvent(depsWithGuard, event);
      expect(first.handled).toBe(true);
      expect(first.creditedCents).toBe(1000);
      expect(first.duplicate).toBeUndefined();

      const second = await handleWebhookEvent(depsWithGuard, event);
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.creditedCents).toBeUndefined();

      // Only credited once
      const balance = await creditRepo.getBalance(TenantId.create("tenant-replay"));
      expect(balance.balance.toCents()).toBe(1000);
    });

    it("returns idempotent 200-style response for duplicates (not error)", async () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };
      const event = createCheckoutEventWithId("evt_test_idem");

      await handleWebhookEvent(depsWithGuard, event);
      const replay = await handleWebhookEvent(depsWithGuard, event);

      // Must return handled: true (200 OK), not an error
      expect(replay.handled).toBe(true);
      expect(replay.event_type).toBe("checkout.session.completed");
    });

    it("allows different event IDs through", async () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };

      const event1 = createCheckoutEventWithId("evt_first");
      const event2 = createCheckoutEventWithId("evt_second", { id: "cs_test_second" });

      const r1 = await handleWebhookEvent(depsWithGuard, event1);
      const r2 = await handleWebhookEvent(depsWithGuard, event2);

      expect(r1.creditedCents).toBe(1000);
      expect(r2.creditedCents).toBe(1000);
      expect(r1.duplicate).toBeUndefined();
      expect(r2.duplicate).toBeUndefined();

      const balance = await creditRepo.getBalance(TenantId.create("tenant-replay"));
      expect(balance.balance.toCents()).toBe(2000);
    });

    it("blocks replay of unhandled event types too", async () => {
      const depsWithGuard: WebhookDeps = { ...deps, replayGuard };
      const event = {
        id: "evt_unknown_replay",
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const first = await handleWebhookEvent(depsWithGuard, event);
      expect(first.handled).toBe(false);
      expect(first.duplicate).toBeUndefined();

      const second = await handleWebhookEvent(depsWithGuard, event);
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
    });

    it("works without replay guard (backwards compatible)", async () => {
      // No replayGuard in deps — should work exactly as before
      const event = createCheckoutEventWithId("evt_no_guard");
      const result = await handleWebhookEvent(deps, event);
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
    it("returns handled:false for customer.subscription.updated", async () => {
      const event = {
        type: "customer.subscription.updated",
        data: { object: {} },
      } as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.updated",
      });
    });

    it("returns handled:false for customer.subscription.deleted", async () => {
      const event = {
        type: "customer.subscription.deleted",
        data: { object: {} },
      } as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.deleted",
      });
    });

    it("returns handled:false for payment_intent.succeeded", async () => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "payment_intent.succeeded",
      });
    });

    it("handles unknown event type gracefully", async () => {
      const event = {
        type: "wopr.custom.event",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "wopr.custom.event",
      });
    });
  });
});
