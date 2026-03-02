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
import { Credit } from "../credit.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { DrizzleWebhookSeenRepository } from "../drizzle-webhook-seen-repository.js";
import { noOpReplayGuard } from "../webhook-seen-repository.js";
import { CREDIT_PRICE_POINTS } from "./credit-prices.js";
import { TenantCustomerRepository } from "./tenant-store.js";
import type { WebhookDeps } from "./webhook.js";
import { handleWebhookEvent } from "./webhook.js";

let db: import("../../db/index.js").DrizzleDb;
let pool: PGlite;

function makeReplayGuard() {
  return new DrizzleWebhookSeenRepository(db);
}

describe("handleWebhookEvent (credit model)", () => {
  let tenantRepo: TenantCustomerRepository;
  let creditLedger: CreditLedger;
  let deps: WebhookDeps;

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
    tenantRepo = new TenantCustomerRepository(db);
    creditLedger = new CreditLedger(db);
    deps = { tenantRepo, creditLedger, replayGuard: noOpReplayGuard };
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

      const mapping = await tenantRepo.getByTenant("tenant-123");
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
      const mapping = await tenantRepo.getByTenant("tenant-123");
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
        type: "balance.available",
        data: { object: {} },
      } as Stripe.Event;

      const first = await handleWebhookEvent(depsWithGuard, event);
      expect(first.handled).toBe(false);
      expect(first.duplicate).toBeUndefined();

      const second = await handleWebhookEvent(depsWithGuard, event);
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
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

      const mapping = await tenantRepo.getByTenant("tenant-vps-1");
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
  // invoice.payment_failed (WOP-1289)
  // ---------------------------------------------------------------------------

  describe("invoice.payment_failed (WOP-1289)", () => {
    function makeInvoiceFailedEvent(overrides?: Record<string, unknown>): Stripe.Event {
      return {
        id: "evt_inv_fail_1",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_test_fail_1",
            customer: "cus_fail_abc",
            subscription: "sub_fail_1",
            amount_due: 500,
            metadata: {},
            ...overrides,
          },
        },
      } as unknown as Stripe.Event;
    }

    it("suspends bots and returns handled:true when tenant found", async () => {
      await tenantRepo.upsert({ tenant: "tenant-fail-1", processorCustomerId: "cus_fail_abc" });

      const botBilling = {
        suspendAllForTenant: vi.fn(async () => ["bot-1", "bot-2"]),
      } as unknown as import("../../monetization/credits/bot-billing.js").BotBilling;

      const result = await handleWebhookEvent({ ...deps, botBilling }, makeInvoiceFailedEvent());

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("invoice.payment_failed");
      expect(result.tenant).toBe("tenant-fail-1");
      expect(result.suspendedBots).toEqual(["bot-1", "bot-2"]);
      expect(botBilling.suspendAllForTenant).toHaveBeenCalledWith("tenant-fail-1");
    });

    it("sends payment_failed notification when notificationService and getEmailForTenant are available", async () => {
      await tenantRepo.upsert({ tenant: "tenant-fail-2", processorCustomerId: "cus_fail_notify" });

      const notifyFn = vi.fn();
      const notificationService = {
        notifyAutoTopUpFailed: notifyFn,
      } as unknown as import("../../email/notification-service.js").NotificationService;
      const getEmailForTenant = vi.fn(() => "user@example.com");

      await handleWebhookEvent(
        { ...deps, notificationService, getEmailForTenant },
        makeInvoiceFailedEvent({ customer: "cus_fail_notify" }),
      );

      expect(getEmailForTenant).toHaveBeenCalledWith("tenant-fail-2");
      expect(notifyFn).toHaveBeenCalledWith("tenant-fail-2", "user@example.com");
    });

    it("returns handled:false when tenant not found for customer", async () => {
      const result = await handleWebhookEvent(deps, makeInvoiceFailedEvent({ customer: "cus_unknown" }));

      expect(result.handled).toBe(false);
      expect(result.event_type).toBe("invoice.payment_failed");
    });

    it("handles customer object instead of string", async () => {
      await tenantRepo.upsert({ tenant: "tenant-fail-obj", processorCustomerId: "cus_obj_fail" });

      const result = await handleWebhookEvent(deps, makeInvoiceFailedEvent({ customer: { id: "cus_obj_fail" } }));

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-fail-obj");
    });

    it("handles missing botBilling gracefully (no suspension, still handled)", async () => {
      await tenantRepo.upsert({ tenant: "tenant-fail-no-billing", processorCustomerId: "cus_fail_no_billing" });

      const result = await handleWebhookEvent(deps, makeInvoiceFailedEvent({ customer: "cus_fail_no_billing" }));

      expect(result.handled).toBe(true);
      expect(result.suspendedBots).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // invoice.payment_succeeded (subscription renewal, WOP-1344)
  // ---------------------------------------------------------------------------

  describe("invoice.payment_succeeded (subscription renewal, WOP-1344)", () => {
    function makeInvoiceSucceededEvent(overrides?: Record<string, unknown>): Stripe.Event {
      return {
        id: "evt_inv_succ_1",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            id: "in_test_succ_1",
            customer: "cus_renew_abc",
            subscription: "sub_renew_1",
            amount_paid: 500,
            metadata: {},
            ...overrides,
          },
        },
      } as unknown as Stripe.Event;
    }

    it("credits ledger on successful subscription renewal", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-1", processorCustomerId: "cus_renew_abc" });

      const result = await handleWebhookEvent(deps, makeInvoiceSucceededEvent());

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("invoice.payment_succeeded");
      expect(result.tenant).toBe("tenant-renew-1");
      expect(result.creditedCents).toBe(500);

      const balance = await creditLedger.balance("tenant-renew-1");
      expect(balance.toCents()).toBe(500);
    });

    it("reactivates suspended bots after successful renewal", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-react", processorCustomerId: "cus_renew_react" });

      const botBilling = {
        checkReactivation: vi.fn(async () => ["bot-r1", "bot-r2"]),
      } as unknown as import("../../monetization/credits/bot-billing.js").BotBilling;

      const result = await handleWebhookEvent(
        { ...deps, botBilling },
        makeInvoiceSucceededEvent({ customer: "cus_renew_react", amount_paid: 1000 }),
      );

      expect(result.handled).toBe(true);
      expect(result.reactivatedBots).toEqual(["bot-r1", "bot-r2"]);
      expect(botBilling.checkReactivation).toHaveBeenCalledWith("tenant-renew-react", creditLedger);
    });

    it("is idempotent — same invoice ID does not double-credit", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-idem", processorCustomerId: "cus_renew_idem" });

      const event = makeInvoiceSucceededEvent({ customer: "cus_renew_idem", amount_paid: 800 });

      const first = await handleWebhookEvent(deps, event);
      expect(first.creditedCents).toBe(800);

      const second = await handleWebhookEvent(deps, event);
      expect(second.handled).toBe(true);
      expect(second.creditedCents).toBe(0);

      // Only credited once
      const balance = await creditLedger.balance("tenant-renew-idem");
      expect(balance.toCents()).toBe(800);
    });

    it("rejects duplicate via replay guard (same event ID twice)", async () => {
      const replayGuard = makeReplayGuard();
      await tenantRepo.upsert({ tenant: "tenant-renew-replay", processorCustomerId: "cus_renew_replay" });

      const event = makeInvoiceSucceededEvent({
        customer: "cus_renew_replay",
        amount_paid: 600,
      });

      const first = await handleWebhookEvent({ ...deps, replayGuard }, event);
      expect(first.handled).toBe(true);
      expect(first.creditedCents).toBe(600);
      expect(first.duplicate).toBeUndefined();

      const second = await handleWebhookEvent({ ...deps, replayGuard }, event);
      expect(second.handled).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.creditedCents).toBeUndefined();

      const balance = await creditLedger.balance("tenant-renew-replay");
      expect(balance.toCents()).toBe(600);
    });

    it("returns handled:false when tenant not found for customer", async () => {
      const result = await handleWebhookEvent(deps, makeInvoiceSucceededEvent({ customer: "cus_unknown_renew" }));

      expect(result.handled).toBe(false);
      expect(result.event_type).toBe("invoice.payment_succeeded");
    });

    it("returns handled:false when customer ID is missing", async () => {
      const result = await handleWebhookEvent(deps, makeInvoiceSucceededEvent({ customer: null }));

      expect(result.handled).toBe(false);
    });

    it("handles customer object instead of string", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-obj", processorCustomerId: "cus_renew_obj" });

      const result = await handleWebhookEvent(
        deps,
        makeInvoiceSucceededEvent({ customer: { id: "cus_renew_obj" }, amount_paid: 750 }),
      );

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-renew-obj");
      expect(result.creditedCents).toBe(750);
    });

    it("returns creditedCents:0 when amount_paid is 0 (free trial renewal)", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-free", processorCustomerId: "cus_renew_free" });

      const result = await handleWebhookEvent(
        deps,
        makeInvoiceSucceededEvent({ customer: "cus_renew_free", amount_paid: 0 }),
      );

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);

      const balance = await creditLedger.balance("tenant-renew-free");
      expect(balance.toCents()).toBe(0);
    });

    it("returns creditedCents:0 when amount_paid is null", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-null", processorCustomerId: "cus_renew_null" });

      const result = await handleWebhookEvent(
        deps,
        makeInvoiceSucceededEvent({ customer: "cus_renew_null", amount_paid: null }),
      );

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("records invoice ID as referenceId in ledger transaction", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-ref", processorCustomerId: "cus_renew_ref" });

      await handleWebhookEvent(
        deps,
        makeInvoiceSucceededEvent({ customer: "cus_renew_ref", id: "in_renewal_abc", amount_paid: 500 }),
      );

      const txns = await creditLedger.history("tenant-renew-ref");
      expect(txns).toHaveLength(1);
      expect(txns[0].referenceId).toBe("in_renewal_abc");
      expect(txns[0].type).toBe("purchase");
      expect(txns[0].description).toContain("in_renewal_abc");
    });

    it("handles missing botBilling gracefully (no reactivation, still credits)", async () => {
      await tenantRepo.upsert({ tenant: "tenant-renew-nobb", processorCustomerId: "cus_renew_nobb" });

      const result = await handleWebhookEvent(
        deps,
        makeInvoiceSucceededEvent({ customer: "cus_renew_nobb", amount_paid: 300 }),
      );

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(300);
      expect(result.reactivatedBots).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // charge.refunded (WOP-1289)
  // ---------------------------------------------------------------------------

  describe("charge.refunded (WOP-1289)", () => {
    function makeChargeRefundedEvent(overrides?: Record<string, unknown>): Stripe.Event {
      return {
        id: "evt_charge_ref_1",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_test_ref_1",
            customer: "cus_ref_abc",
            amount: 2500,
            amount_refunded: 2500,
            currency: "usd",
            metadata: {},
            ...overrides,
          },
        },
      } as unknown as Stripe.Event;
    }

    it("debits the credit ledger for the refunded amount", async () => {
      await tenantRepo.upsert({ tenant: "tenant-ref-1", processorCustomerId: "cus_ref_abc" });
      await creditLedger.credit("tenant-ref-1", Credit.fromCents(5000), "purchase", "seed");

      const result = await handleWebhookEvent(deps, makeChargeRefundedEvent());

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("charge.refunded");
      expect(result.tenant).toBe("tenant-ref-1");
      expect(result.debitedCents).toBe(2500);

      expect((await creditLedger.balance("tenant-ref-1")).toCents()).toBe(2500);
    });

    it("allows negative balance after refund (tenant already spent credits)", async () => {
      await tenantRepo.upsert({ tenant: "tenant-ref-neg", processorCustomerId: "cus_ref_neg" });

      const result = await handleWebhookEvent(
        deps,
        makeChargeRefundedEvent({ customer: "cus_ref_neg", amount_refunded: 1000 }),
      );

      expect(result.handled).toBe(true);
      expect(result.debitedCents).toBe(1000);
      expect((await creditLedger.balance("tenant-ref-neg")).toCents()).toBe(-1000);
    });

    it("is idempotent — skips duplicate refund for same charge ID", async () => {
      await tenantRepo.upsert({ tenant: "tenant-ref-idem", processorCustomerId: "cus_ref_idem" });
      await creditLedger.credit("tenant-ref-idem", Credit.fromCents(5000), "purchase", "seed");

      const event = makeChargeRefundedEvent({ customer: "cus_ref_idem" });

      const first = await handleWebhookEvent(deps, event);
      expect(first.debitedCents).toBe(2500);

      const second = await handleWebhookEvent(deps, event);
      expect(second.handled).toBe(true);
      expect(second.debitedCents).toBe(0);

      expect((await creditLedger.balance("tenant-ref-idem")).toCents()).toBe(2500);
    });

    it("returns handled:false when tenant not found for customer", async () => {
      const result = await handleWebhookEvent(deps, makeChargeRefundedEvent({ customer: "cus_unknown_ref" }));

      expect(result.handled).toBe(false);
    });

    it("returns handled:false when amount_refunded is 0", async () => {
      await tenantRepo.upsert({ tenant: "tenant-ref-zero", processorCustomerId: "cus_ref_zero" });

      const result = await handleWebhookEvent(
        deps,
        makeChargeRefundedEvent({ customer: "cus_ref_zero", amount_refunded: 0 }),
      );

      expect(result.handled).toBe(false);
    });

    it("handles customer object instead of string", async () => {
      await tenantRepo.upsert({ tenant: "tenant-ref-obj", processorCustomerId: "cus_ref_obj" });
      await creditLedger.credit("tenant-ref-obj", Credit.fromCents(3000), "purchase", "seed");

      const result = await handleWebhookEvent(
        deps,
        makeChargeRefundedEvent({ customer: { id: "cus_ref_obj" }, amount_refunded: 1500 }),
      );

      expect(result.handled).toBe(true);
      expect(result.debitedCents).toBe(1500);
    });

    it("records charge ID as referenceId in the ledger transaction", async () => {
      await tenantRepo.upsert({ tenant: "tenant-ref-txn", processorCustomerId: "cus_ref_txn" });
      await creditLedger.credit("tenant-ref-txn", Credit.fromCents(5000), "purchase", "seed");

      await handleWebhookEvent(deps, makeChargeRefundedEvent({ customer: "cus_ref_txn", id: "ch_ref_txn_123" }));

      const txns = await creditLedger.history("tenant-ref-txn", { type: "refund" });
      expect(txns).toHaveLength(1);
      expect(txns[0].referenceId).toBe("ch_ref_txn_123");
      expect(txns[0].type).toBe("refund");
      expect(txns[0].description).toContain("ch_ref_txn_123");
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

  // ---------------------------------------------------------------------------
  // payment_intent.succeeded (auto-topup fallback, WOP-1097)
  // ---------------------------------------------------------------------------

  describe("payment_intent.succeeded (auto-topup fallback)", () => {
    it("credits ledger when PI has wopr_tenant metadata and referenceId is new", async () => {
      const event = {
        id: "evt_pi_success_1",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_fallback_1",
            amount: 500,
            currency: "usd",
            metadata: {
              wopr_tenant: "t1",
              wopr_source: "auto_topup_usage",
            },
          },
        },
      } as unknown as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("payment_intent.succeeded");
      expect(result.tenant).toBe("t1");
      expect(result.creditedCents).toBe(500);
      expect((await creditLedger.balance("t1")).toCents()).toBe(500);
    });

    it("skips credit when referenceId already exists (inline grant ran first)", async () => {
      // Simulate inline grant already happened
      await creditLedger.credit("t1", Credit.fromCents(500), "purchase", "Auto-topup", "pi_already_granted", "stripe");

      const event = {
        id: "evt_pi_success_2",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_already_granted",
            amount: 500,
            currency: "usd",
            metadata: {
              wopr_tenant: "t1",
              wopr_source: "auto_topup_usage",
            },
          },
        },
      } as unknown as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
      // Balance should still be 500, not 1000
      expect((await creditLedger.balance("t1")).toCents()).toBe(500);
    });

    it("returns handled:false when wopr_tenant metadata is missing", async () => {
      const event = {
        id: "evt_pi_no_tenant",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_no_tenant",
            amount: 500,
            currency: "usd",
            metadata: {},
          },
        },
      } as unknown as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
      expect(result.event_type).toBe("payment_intent.succeeded");
    });

    it("returns handled:false when amount is zero", async () => {
      const event = {
        id: "evt_pi_zero",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_zero",
            amount: 0,
            currency: "usd",
            metadata: { wopr_tenant: "t1", wopr_source: "auto_topup_usage" },
          },
        },
      } as unknown as Stripe.Event;

      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // charge.dispute.created (WOP-1303)
  // ---------------------------------------------------------------------------

  describe("charge.dispute.created (WOP-1303)", () => {
    // Customer is embedded in the expanded charge object (not directly on Dispute).
    function makeDisputeCreatedEvent(
      customerId: string | { id: string } | null = "cus_dispute_abc",
      overrides?: Record<string, unknown>,
    ): Stripe.Event {
      return {
        id: "evt_dispute_1",
        type: "charge.dispute.created",
        data: {
          object: {
            id: "dp_test_1",
            charge: { id: "ch_disputed_1", customer: customerId },
            amount: 2500,
            currency: "usd",
            reason: "fraudulent",
            status: "needs_response",
            metadata: {},
            ...overrides,
          },
        },
      } as unknown as Stripe.Event;
    }

    it("freezes tenant credits and suspends bots on dispute", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dispute-1", processorCustomerId: "cus_dispute_abc" });
      await creditLedger.credit("tenant-dispute-1", Credit.fromCents(5000), "purchase", "seed");

      const botBilling = {
        suspendAllForTenant: vi.fn(async () => ["bot-d1"]),
      } as unknown as import("../credits/bot-billing.js").BotBilling;

      const result = await handleWebhookEvent({ ...deps, botBilling }, makeDisputeCreatedEvent());

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("charge.dispute.created");
      expect(result.tenant).toBe("tenant-dispute-1");
      expect(result.disputeId).toBe("dp_test_1");
      expect(result.suspendedBots).toEqual(["bot-d1"]);

      expect(await tenantRepo.hasBillingHold("tenant-dispute-1")).toBe(true);
      expect((await creditLedger.balance("tenant-dispute-1")).toCents()).toBe(2500);
    });

    it("allows negative balance when dispute amount exceeds current balance", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dispute-neg", processorCustomerId: "cus_dispute_neg" });

      const result = await handleWebhookEvent(deps, makeDisputeCreatedEvent("cus_dispute_neg", { amount: 1000 }));

      expect(result.handled).toBe(true);
      expect((await creditLedger.balance("tenant-dispute-neg")).toCents()).toBe(-1000);
    });

    it("is idempotent — skips duplicate debit for same dispute ID", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dispute-idem", processorCustomerId: "cus_dispute_idem" });
      await creditLedger.credit("tenant-dispute-idem", Credit.fromCents(5000), "purchase", "seed");

      const event = makeDisputeCreatedEvent("cus_dispute_idem");

      await handleWebhookEvent(deps, event);
      await handleWebhookEvent(deps, event);

      // Only debited once
      expect((await creditLedger.balance("tenant-dispute-idem")).toCents()).toBe(2500);
    });

    it("sends admin notification when notificationService is available", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dispute-notify", processorCustomerId: "cus_dispute_notify" });
      await creditLedger.credit("tenant-dispute-notify", Credit.fromCents(5000), "purchase", "seed");

      const notifyFn = vi.fn();
      const notificationService = {
        notifyDisputeCreated: notifyFn,
      } as unknown as import("../../email/notification-service.js").NotificationService;
      const getEmailForTenant = vi.fn(() => "admin@example.com");

      await handleWebhookEvent(
        { ...deps, notificationService, getEmailForTenant },
        makeDisputeCreatedEvent("cus_dispute_notify"),
      );

      expect(getEmailForTenant).toHaveBeenCalledWith("tenant-dispute-notify");
      expect(notifyFn).toHaveBeenCalledWith(
        "tenant-dispute-notify",
        "admin@example.com",
        "dp_test_1",
        "$25.00",
        "fraudulent",
      );
    });

    it("returns handled:false when tenant not found for customer", async () => {
      const result = await handleWebhookEvent(deps, makeDisputeCreatedEvent("cus_unknown_dispute"));

      expect(result.handled).toBe(false);
      expect(result.event_type).toBe("charge.dispute.created");
    });

    it("returns handled:false when charge is a plain string (no expanded customer)", async () => {
      const event = {
        id: "evt_dispute_noexp",
        type: "charge.dispute.created",
        data: {
          object: {
            id: "dp_noexp_1",
            charge: "ch_plain_string",
            amount: 1000,
            currency: "usd",
            reason: "fraudulent",
            status: "needs_response",
            metadata: {},
          },
        },
      } as unknown as Stripe.Event;
      const result = await handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
    });

    it("handles customer object (expanded) inside charge", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dispute-obj", processorCustomerId: "cus_dispute_obj" });
      await creditLedger.credit("tenant-dispute-obj", Credit.fromCents(3000), "purchase", "seed");

      const result = await handleWebhookEvent(deps, makeDisputeCreatedEvent({ id: "cus_dispute_obj" }));

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-dispute-obj");
    });

    it("works without botBilling (no suspension, still handled)", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dispute-no-bb", processorCustomerId: "cus_dispute_no_bb" });
      await creditLedger.credit("tenant-dispute-no-bb", Credit.fromCents(5000), "purchase", "seed");

      const result = await handleWebhookEvent(deps, makeDisputeCreatedEvent("cus_dispute_no_bb"));

      expect(result.handled).toBe(true);
      expect(result.suspendedBots).toBeUndefined();
      expect(await tenantRepo.hasBillingHold("tenant-dispute-no-bb")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // charge.dispute.closed (WOP-1303)
  // ---------------------------------------------------------------------------

  describe("charge.dispute.closed (WOP-1303)", () => {
    // Customer is embedded in the expanded charge object (not directly on Dispute).
    function makeDisputeClosedEvent(
      customerId: string | { id: string } = "cus_dispute_closed_abc",
      overrides?: Record<string, unknown>,
    ): Stripe.Event {
      return {
        id: "evt_dispute_closed_1",
        type: "charge.dispute.closed",
        data: {
          object: {
            id: "dp_closed_1",
            charge: { id: "ch_disputed_closed", customer: customerId },
            amount: 2500,
            currency: "usd",
            reason: "fraudulent",
            status: "won",
            metadata: {},
            ...overrides,
          },
        },
      } as unknown as Stripe.Event;
    }

    it("unfreezes tenant and re-credits when dispute is won", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dw-1", processorCustomerId: "cus_dispute_closed_abc" });
      await tenantRepo.setBillingHold("tenant-dw-1", true);

      const botBilling = {
        checkReactivation: vi.fn(async () => ["bot-r1"]),
      } as unknown as import("../credits/bot-billing.js").BotBilling;

      const result = await handleWebhookEvent({ ...deps, botBilling }, makeDisputeClosedEvent());

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("charge.dispute.closed");
      expect(result.tenant).toBe("tenant-dw-1");
      expect(result.disputeId).toBe("dp_closed_1");
      expect(result.reactivatedBots).toEqual(["bot-r1"]);

      expect(await tenantRepo.hasBillingHold("tenant-dw-1")).toBe(false);
      expect((await creditLedger.balance("tenant-dw-1")).toCents()).toBe(2500);
    });

    it("does NOT unfreeze or re-credit when dispute is lost", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dl-1", processorCustomerId: "cus_dispute_lost" });
      await tenantRepo.setBillingHold("tenant-dl-1", true);

      const result = await handleWebhookEvent(deps, makeDisputeClosedEvent("cus_dispute_lost", { status: "lost" }));

      expect(result.handled).toBe(true);
      expect(result.disputeId).toBe("dp_closed_1");

      expect(await tenantRepo.hasBillingHold("tenant-dl-1")).toBe(true);
      expect((await creditLedger.balance("tenant-dl-1")).toCents()).toBe(0);
    });

    it("is idempotent — skips duplicate re-credit for same dispute reversal", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dw-idem", processorCustomerId: "cus_dw_idem" });
      await tenantRepo.setBillingHold("tenant-dw-idem", true);

      const event = makeDisputeClosedEvent("cus_dw_idem");

      await handleWebhookEvent(deps, event);
      expect((await creditLedger.balance("tenant-dw-idem")).toCents()).toBe(2500);

      await handleWebhookEvent(deps, event);
      // Still 2500, not 5000
      expect((await creditLedger.balance("tenant-dw-idem")).toCents()).toBe(2500);
    });

    it("sends dispute-won notification when dispute is won", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dw-notify", processorCustomerId: "cus_dw_notify" });
      await tenantRepo.setBillingHold("tenant-dw-notify", true);

      const notifyFn = vi.fn();
      const notificationService = {
        notifyDisputeWon: notifyFn,
      } as unknown as import("../../email/notification-service.js").NotificationService;
      const getEmailForTenant = vi.fn(() => "admin@example.com");

      await handleWebhookEvent(
        { ...deps, notificationService, getEmailForTenant },
        makeDisputeClosedEvent("cus_dw_notify"),
      );

      expect(notifyFn).toHaveBeenCalledWith("tenant-dw-notify", "admin@example.com", "dp_closed_1", "$25.00");
    });

    it("returns handled:false when tenant not found", async () => {
      const result = await handleWebhookEvent(deps, makeDisputeClosedEvent("cus_unknown_dc"));

      expect(result.handled).toBe(false);
    });

    it("handles customer object (expanded) inside charge", async () => {
      await tenantRepo.upsert({ tenant: "tenant-dw-obj", processorCustomerId: "cus_dw_obj" });
      await tenantRepo.setBillingHold("tenant-dw-obj", true);

      const result = await handleWebhookEvent(deps, makeDisputeClosedEvent({ id: "cus_dw_obj" }));

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-dw-obj");
    });
  });
});
