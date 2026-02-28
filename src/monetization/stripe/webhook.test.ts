/**
 * Unit tests for Stripe webhook handler (credit purchase model, WOP-406).
 *
 * Covers checkout.session.completed crediting the ledger,
 * bonus tier application, edge cases, and unknown events.
 */
import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleAffiliateRepository } from "../affiliate/drizzle-affiliate-repository.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { DrizzleWebhookSeenRepository } from "../drizzle-webhook-seen-repository.js";
import { CREDIT_PRICE_POINTS } from "./credit-prices.js";
import { TenantCustomerStore } from "./tenant-store.js";
import type { WebhookDeps } from "./webhook.js";
import { handleWebhookEvent } from "./webhook.js";

async function makeReplayGuard() {
  const { db } = await createTestDb();
  return new DrizzleWebhookSeenRepository(db);
}

describe("handleWebhookEvent (credit model)", () => {
  let tenantStore: TenantCustomerStore;
  let creditLedger: CreditLedger;
  let deps: WebhookDeps;
  let pool: PGlite;
  let db: import("../../db/index.js").DrizzleDb;

  beforeAll(async () => {
    const testDb = await createTestDb();
    pool = testDb.pool;
    db = testDb.db;
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    tenantStore = new TenantCustomerStore(db);
    creditLedger = new CreditLedger(db);
    deps = { tenantStore, creditLedger };
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
      const balance = await creditLedger.balance("tenant-123");
      expect(balance.toCents()).toBe(2500);
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

      const mapping = await tenantStore.getByTenant("tenant-123");
      expect(mapping).not.toBeNull();
      expect(mapping?.processor_customer_id).toBe("cus_abc");
    });

    it("handles tenant from metadata when client_reference_id is null", async () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: { wopr_tenant: "tenant-from-metadata" },
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-from-metadata");

      const balance = await creditLedger.balance("tenant-from-metadata");
      expect(balance.toCents()).toBe(2500);
    });

    it("handles customer object instead of string", async () => {
      const event = createCheckoutEvent({
        customer: { id: "cus_obj_123" } as Stripe.Customer,
      });
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      const mapping = await tenantStore.getByTenant("tenant-123");
      expect(mapping?.processor_customer_id).toBe("cus_obj_123");
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
      const balance = await creditLedger.balance("tenant-123");
      expect(balance.toCents()).toBe(500);
    });

    it("grants 1:1 credits when no priceMap is provided", async () => {
      const event = createCheckoutEvent({ amount_total: 1234 });
      const result = await handleWebhookEvent(deps, event);

      expect(result.creditedCents).toBe(1234);
    });

    it("records the Stripe session ID in the transaction description and referenceId", async () => {
      const event = createCheckoutEvent({ id: "cs_test_abc" });
      await handleWebhookEvent(deps, event);

      const txns = await creditLedger.history("tenant-123");
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toContain("cs_test_abc");
      expect(txns[0].type).toBe("purchase");
      expect(txns[0].referenceId).toBe("cs_test_abc");
    });

    it("grants affiliate match credits on first purchase for referred tenant (WOP-949)", async () => {
      const affiliateRepo = new DrizzleAffiliateRepository(db);
      await affiliateRepo.recordReferral("referrer-tenant", "tenant-123", "ref123");

      const depsWithAffiliate: WebhookDeps = { ...deps, affiliateRepo };
      const event = createCheckoutEvent({ amount_total: 2000, id: "cs_affiliate_test" });
      const result = await handleWebhookEvent(depsWithAffiliate, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(2000);

      // Referrer should have received matching credits
      expect((await creditLedger.balance("referrer-tenant")).toCents()).toBe(2000);

      // Referral record should be updated
      const ref = await affiliateRepo.getReferralByReferred("tenant-123");
      expect(ref?.matchAmount?.toCents()).toBe(2000);
      expect(ref?.matchedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Replay attack prevention (WOP-476)
  // ---------------------------------------------------------------------------

  describe("replay attack prevention", () => {
    let replayGuard: DrizzleWebhookSeenRepository;

    beforeEach(async () => {
      replayGuard = await makeReplayGuard();
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
      const balance = await creditLedger.balance("tenant-replay");
      expect(balance.toCents()).toBe(1000);
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

      const balance = await creditLedger.balance("tenant-replay");
      expect(balance.toCents()).toBe(2000);
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
  // DrizzleWebhookSeenRepository unit tests (replaces WebhookReplayGuard)
  // ---------------------------------------------------------------------------

  describe("DrizzleWebhookSeenRepository (stripe replay guard)", () => {
    it("reports unseen event IDs as not duplicate", async () => {
      const guard = await makeReplayGuard();
      expect(await guard.isDuplicate("evt_new", "stripe")).toBe(false);
    });

    it("reports seen event IDs as duplicate", async () => {
      const guard = await makeReplayGuard();
      await guard.markSeen("evt_seen", "stripe");
      expect(await guard.isDuplicate("evt_seen", "stripe")).toBe(true);
    });

    it("purges expired entries via purgeExpired", async () => {
      const guard = await makeReplayGuard();
      await guard.markSeen("evt_expire", "stripe");
      expect(await guard.isDuplicate("evt_expire", "stripe")).toBe(true);
      // Negative TTL pushes cutoff into the future — entry is expired
      await guard.purgeExpired(-24 * 60 * 60 * 1000);
      expect(await guard.isDuplicate("evt_expire", "stripe")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // New-user affiliate bonus (WOP-950)
  // ---------------------------------------------------------------------------

  describe("new-user affiliate bonus (WOP-950)", () => {
    let affiliateRepo: DrizzleAffiliateRepository;
    let depsWithAffiliate: WebhookDeps;

    function createCheckoutEvent(overrides?: Partial<Stripe.Checkout.Session>): Stripe.Event {
      return {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_affiliate_test",
            client_reference_id: "tenant-123",
            customer: "cus_abc",
            amount_total: 5000,
            metadata: {},
            ...overrides,
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
    }

    beforeEach(async () => {
      const { db } = await createTestDb();
      affiliateRepo = new DrizzleAffiliateRepository(db);
      depsWithAffiliate = { ...deps, affiliateRepo };
    });

    it("grants bonus to referred user on first purchase", async () => {
      await affiliateRepo.getOrCreateCode("referrer-1");
      const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
      await affiliateRepo.recordReferral("referrer-1", "tenant-123", code);

      const event = createCheckoutEvent({ amount_total: 5000 });
      const result = await handleWebhookEvent(depsWithAffiliate, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(5000);
      expect(result.affiliateBonus?.toCents()).toBe(1000); // 20% of 5000

      // Total balance = purchase + bonus
      expect((await creditLedger.balance("tenant-123")).toCents()).toBe(6000);
    });

    it("does not grant bonus to non-referred user", async () => {
      const event = createCheckoutEvent({ amount_total: 5000 });
      const result = await handleWebhookEvent(depsWithAffiliate, event);

      expect(result.affiliateBonus?.toCents()).toBeUndefined();
      expect((await creditLedger.balance("tenant-123")).toCents()).toBe(5000);
    });

    it("does not grant bonus on second purchase", async () => {
      await affiliateRepo.getOrCreateCode("referrer-1");
      const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
      await affiliateRepo.recordReferral("referrer-1", "tenant-123", code);

      const event1 = createCheckoutEvent({ id: "cs_first", amount_total: 5000 });
      await handleWebhookEvent(depsWithAffiliate, event1);

      const event2 = createCheckoutEvent({ id: "cs_second", amount_total: 3000 });
      const result2 = await handleWebhookEvent(depsWithAffiliate, event2);

      expect(result2.affiliateBonus?.toCents()).toBeUndefined();
      // Balance = 5000 (first purchase) + 1000 (bonus) + 3000 (second purchase) = 9000
      expect((await creditLedger.balance("tenant-123")).toCents()).toBe(9000);
    });

    it("works without affiliateRepo in deps (backwards compatible)", async () => {
      const event = createCheckoutEvent({ id: "cs_no_affiliate", amount_total: 2500 });
      const result = await handleWebhookEvent(deps, event);

      expect(result.affiliateBonus?.toCents()).toBeUndefined();
      expect(result.creditedCents).toBe(2500);
    });
  });

  // ---------------------------------------------------------------------------
  // VPS subscription webhook paths (WOP-741)
  // ---------------------------------------------------------------------------

  describe("VPS subscription events (WOP-741)", () => {
    function makeVpsRepo() {
      const store = new Map<string, Record<string, unknown>>();
      const repo = {
        getByBotId: vi.fn(async (botId: string) => store.get(botId) ?? null),
        create: vi.fn(
          async (sub: {
            botId: string;
            tenantId: string;
            stripeSubscriptionId: string;
            stripeCustomerId: string;
            hostname: string;
          }) => {
            store.set(sub.botId, { ...sub, status: "active" });
          },
        ),
        updateStatus: vi.fn(async (botId: string, status: string) => {
          const row = store.get(botId);
          if (row) store.set(botId, { ...row, status });
        }),
        getBySubscriptionId: vi.fn(),
        listByTenant: vi.fn(),
        setSshPublicKey: vi.fn(),
        setTunnelId: vi.fn(),
        delete: vi.fn(),
      };
      return repo as unknown as import("../../fleet/vps-repository.js").IVpsRepository & typeof repo;
    }

    function makeSubEvent(type: string, overrides?: Partial<Stripe.Subscription>): Stripe.Event {
      return {
        type,
        data: {
          object: {
            id: "sub_test_123",
            customer: "cus_vps_abc",
            status: "active",
            cancel_at_period_end: false,
            metadata: {
              wopr_bot_id: "bot-vps-1",
              wopr_tenant: "tenant-vps-1",
              wopr_purchase_type: "vps",
            },
            ...overrides,
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
    }

    it("creates VPS subscription on customer.subscription.created (active)", async () => {
      const vpsRepo = makeVpsRepo();
      const event = makeSubEvent("customer.subscription.created");
      const result = await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-vps-1");
      expect(vpsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: "bot-vps-1",
          tenantId: "tenant-vps-1",
          stripeSubscriptionId: "sub_test_123",
          stripeCustomerId: "cus_vps_abc",
        }),
      );
    });

    it("upserts tenant-customer mapping on subscription created", async () => {
      const vpsRepo = makeVpsRepo();
      const event = makeSubEvent("customer.subscription.created");
      await handleWebhookEvent({ ...deps, vpsRepo }, event);

      const mapping = await tenantStore.getByTenant("tenant-vps-1");
      expect(mapping?.processor_customer_id).toBe("cus_vps_abc");
    });

    it("updates status to active when bot already exists", async () => {
      const vpsRepo = makeVpsRepo();
      // Pre-populate so getByBotId returns existing
      await vpsRepo.create({
        botId: "bot-vps-1",
        tenantId: "tenant-vps-1",
        stripeSubscriptionId: "sub_old",
        stripeCustomerId: "cus_vps_abc",
        hostname: "tenant-vps-1.bot.wopr.bot",
      });
      vpsRepo.getByBotId = vi.fn(async () =>
        vpsRepo.create.mock.calls.length > 0 ? ({ botId: "bot-vps-1", status: "canceling" } as never) : null,
      );

      const event = makeSubEvent("customer.subscription.updated", { status: "active" });
      const result = await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(result.handled).toBe(true);
      expect(vpsRepo.updateStatus).toHaveBeenCalledWith("bot-vps-1", "active");
    });

    it("sets status to canceling when cancel_at_period_end is true (non-active status)", async () => {
      const vpsRepo = makeVpsRepo();
      vpsRepo.getByBotId = vi.fn(async () => ({ botId: "bot-vps-1" }) as never);

      const event = makeSubEvent("customer.subscription.updated", {
        status: "trialing" as Stripe.Subscription["status"],
        cancel_at_period_end: true,
      });
      await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(vpsRepo.updateStatus).toHaveBeenCalledWith("bot-vps-1", "canceling");
    });

    it("sets status to canceled on subscription canceled", async () => {
      const vpsRepo = makeVpsRepo();
      vpsRepo.getByBotId = vi.fn(async () => ({ botId: "bot-vps-1" }) as never);

      const event = makeSubEvent("customer.subscription.updated", { status: "canceled" });
      await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(vpsRepo.updateStatus).toHaveBeenCalledWith("bot-vps-1", "canceled");
    });

    it("cancels VPS on customer.subscription.deleted", async () => {
      const vpsRepo = makeVpsRepo();
      vpsRepo.getByBotId = vi.fn(async () => ({ botId: "bot-vps-1" }) as never);

      const event = makeSubEvent("customer.subscription.deleted");
      const result = await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(result.handled).toBe(true);
      expect(vpsRepo.updateStatus).toHaveBeenCalledWith("bot-vps-1", "canceled");
    });

    it("returns handled:false when vpsRepo is not provided", async () => {
      const event = makeSubEvent("customer.subscription.created");
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
    });

    it("returns handled:false when metadata is missing botId", async () => {
      const vpsRepo = makeVpsRepo();
      const event = makeSubEvent("customer.subscription.created", {
        metadata: { wopr_tenant: "t-1", wopr_purchase_type: "vps" },
      });
      const result = await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(result.handled).toBe(false);
    });

    it("returns handled:false for non-vps purchase type", async () => {
      const vpsRepo = makeVpsRepo();
      const event = makeSubEvent("customer.subscription.created", {
        metadata: { wopr_bot_id: "bot-1", wopr_tenant: "t-1", wopr_purchase_type: "other" },
      });
      const result = await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(result.handled).toBe(false);
    });

    it("handles customer object (non-string) in subscription", async () => {
      const vpsRepo = makeVpsRepo();
      const event = makeSubEvent("customer.subscription.created", {
        customer: { id: "cus_obj_vps" } as Stripe.Customer,
      });
      await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(vpsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ stripeCustomerId: "cus_obj_vps" }));
    });

    it("returns handled:false for subscription.deleted when no botId in metadata", async () => {
      const vpsRepo = makeVpsRepo();
      const event = makeSubEvent("customer.subscription.deleted", { metadata: {} });
      const result = await handleWebhookEvent({ ...deps, vpsRepo }, event);

      expect(result.handled).toBe(false);
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
