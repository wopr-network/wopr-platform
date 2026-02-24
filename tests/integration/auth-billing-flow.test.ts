/**
 * Integration tests for auth-to-billing flow (credit purchase model, WOP-406).
 *
 * Tests the complete journey:
 * 1. User registers (auth)
 * 2. User purchases credits (billing)
 * 3. Credits land in the ledger (webhook)
 * 4. Multiple tenants remain isolated
 */
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCreditAdjustmentSchema } from "../../src/admin/credits/schema.js";
import { createDb } from "../../src/db/index.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { initCreditSchema } from "../../src/monetization/credits/schema.js";
import { initStripeSchema } from "../../src/monetization/stripe/schema.js";
import { TenantCustomerStore } from "../../src/monetization/stripe/tenant-store.js";
import type { WebhookDeps } from "../../src/monetization/stripe/webhook.js";
import { handleWebhookEvent } from "../../src/monetization/stripe/webhook.js";

describe("integration: auth → billing → credit flow", () => {
  let sqlite: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;
  let creditLedger: CreditLedger;
  let deps: WebhookDeps;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initStripeSchema(sqlite);
    initCreditAdjustmentSchema(sqlite);
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
  // Complete flow: Register → Purchase credits → Verify balance
  // ---------------------------------------------------------------------------

  describe("complete user journey", () => {
    it("free tier user → purchases credits → balance updated", () => {
      const tenantId = "tenant-journey-1";

      // Step 1: User registers (starts on free tier)
      tenantStore.upsert({
        tenant: tenantId,
        processorCustomerId: "cus_new_user",
      });
      tenantStore.setTier(tenantId, "free");

      let mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");
      expect(creditLedger.balance(tenantId)).toBe(0);

      // Step 2: User completes a $10 credit purchase via Stripe checkout
      const checkoutEvent: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_purchase1",
            client_reference_id: tenantId,
            customer: "cus_new_user",
            amount_total: 1000,
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, checkoutEvent);
      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(1000);

      // Step 3: Balance reflects the purchase
      expect(creditLedger.balance(tenantId)).toBe(1000);

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.processor_customer_id).toBe("cus_new_user");
    });

    it("handles multiple credit purchases accumulating balance", () => {
      const tenantId = "tenant-multi-purchase";

      tenantStore.upsert({
        tenant: tenantId,
        processorCustomerId: "cus_multi",
      });

      // First purchase: $5
      const purchase1: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_p1",
            client_reference_id: tenantId,
            customer: "cus_multi",
            amount_total: 500,
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
      handleWebhookEvent(deps, purchase1);
      expect(creditLedger.balance(tenantId)).toBe(500);

      // Second purchase: $10
      const purchase2: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_p2",
            client_reference_id: tenantId,
            customer: "cus_multi",
            amount_total: 1000,
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
      handleWebhookEvent(deps, purchase2);
      expect(creditLedger.balance(tenantId)).toBe(1500);
    });

    it("handles checkout for tenant identified via metadata", () => {
      const tenantId = "tenant-from-metadata";

      const checkoutEvent: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_meta",
            client_reference_id: null,
            customer: "cus_meta",
            amount_total: 500,
            metadata: { wopr_tenant: tenantId },
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, checkoutEvent);
      expect(result.handled).toBe(true);
      expect(result.tenant).toBe(tenantId);
      expect(creditLedger.balance(tenantId)).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-tenant isolation
  // ---------------------------------------------------------------------------

  describe("multi-tenant isolation", () => {
    it("credit purchases for different tenants are independent", () => {
      const tenant1 = "tenant-credit-1";
      const tenant2 = "tenant-credit-2";

      // Tenant 1 purchases $10
      const purchase1: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_t1",
            client_reference_id: tenant1,
            customer: "cus_1",
            amount_total: 1000,
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
      handleWebhookEvent(deps, purchase1);

      // Tenant 2 purchases $5
      const purchase2: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_t2",
            client_reference_id: tenant2,
            customer: "cus_2",
            amount_total: 500,
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
      handleWebhookEvent(deps, purchase2);

      expect(creditLedger.balance(tenant1)).toBe(1000);
      expect(creditLedger.balance(tenant2)).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // Error scenarios
  // ---------------------------------------------------------------------------

  describe("error scenarios", () => {
    it("handles subscription events for unknown customers", () => {
      const updateEvent: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_unknown",
            customer: "cus_unknown",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, updateEvent);
      expect(result.handled).toBe(false);
    });
  });
});
