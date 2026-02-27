import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPaymentProcessor } from "../payment-processor.js";
import { StripePaymentProcessor } from "./stripe-payment-processor.js";

function makeMockStripe() {
  return {
    checkout: {
      sessions: { create: vi.fn() },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
    billingPortal: {
      sessions: { create: vi.fn() },
    },
    setupIntents: {
      create: vi.fn(),
    },
    customers: {
      listPaymentMethods: vi.fn(),
    },
    paymentMethods: {
      detach: vi.fn(),
      retrieve: vi.fn(),
    },
    paymentIntents: {
      create: vi.fn(),
    },
  } as unknown as Stripe;
}

function makeMockTenantStore() {
  return {
    getByTenant: vi.fn(),
    getByProcessorCustomerId: vi.fn(),
    upsert: vi.fn(),
    setTier: vi.fn(),
    setBillingHold: vi.fn(),
    hasBillingHold: vi.fn(),
    getInferenceMode: vi.fn(),
    setInferenceMode: vi.fn(),
    list: vi.fn(),
    buildCustomerIdMap: vi.fn(),
  };
}

describe("StripePaymentProcessor", () => {
  let stripe: ReturnType<typeof makeMockStripe>;
  let tenantStore: ReturnType<typeof makeMockTenantStore>;
  let processor: IPaymentProcessor;

  beforeEach(() => {
    stripe = makeMockStripe();
    tenantStore = makeMockTenantStore();
    processor = new StripePaymentProcessor({
      stripe,
      tenantStore,
      webhookSecret: "whsec_test",
      creditLedger: {
        credit: vi.fn(),
        debit: vi.fn(),
        balance: vi.fn(),
        hasReferenceId: vi.fn().mockReturnValue(false),
        history: vi.fn(),
        tenantsWithBalance: vi.fn(),
      } as unknown as import("../credits/credit-ledger.js").ICreditLedger,
    });
  });

  it("implements IPaymentProcessor", () => {
    expect(processor.name).toBe("stripe");
    expect(typeof processor.createCheckoutSession).toBe("function");
    expect(typeof processor.handleWebhook).toBe("function");
    expect(typeof processor.supportsPortal).toBe("function");
    expect(typeof processor.setupPaymentMethod).toBe("function");
    expect(typeof processor.listPaymentMethods).toBe("function");
    expect(typeof processor.charge).toBe("function");
  });

  it("name is 'stripe'", () => {
    expect(processor.name).toBe("stripe");
  });

  it("supportsPortal returns true", () => {
    expect(processor.supportsPortal()).toBe(true);
  });

  describe("createCheckoutSession", () => {
    it("creates a checkout session and returns id + url", async () => {
      tenantStore.getByTenant.mockReturnValue(null);
      const mockSession = {
        id: "cs_test_123",
        url: "https://checkout.stripe.com/cs_test_123",
      };
      (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const priceMap = new Map([["price_500", { label: "$5", amountCredits: 500, creditCents: 500, bonusPercent: 0 }]]);
      const proc = new StripePaymentProcessor({
        stripe,
        tenantStore,
        webhookSecret: "whsec_test",
        priceMap,
        creditLedger: {
          credit: vi.fn(),
          debit: vi.fn(),
          balance: vi.fn(),
          hasReferenceId: vi.fn().mockReturnValue(false),
          history: vi.fn(),
          tenantsWithBalance: vi.fn(),
        } as unknown as import("../credits/credit-ledger.js").ICreditLedger,
      });

      const result = await proc.createCheckoutSession({
        tenant: "t-1",
        amount: 500 as unknown as import("../credit.js").Credit,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

      expect(result.id).toBe("cs_test_123");
      expect(result.url).toBe("https://checkout.stripe.com/cs_test_123");
    });

    it("throws when no matching price tier found", async () => {
      const proc = new StripePaymentProcessor({
        stripe,
        tenantStore,
        webhookSecret: "whsec_test",
        priceMap: new Map(),
        creditLedger: {
          credit: vi.fn(),
          debit: vi.fn(),
          balance: vi.fn(),
          hasReferenceId: vi.fn().mockReturnValue(false),
          history: vi.fn(),
          tenantsWithBalance: vi.fn(),
        } as unknown as import("../credits/credit-ledger.js").ICreditLedger,
      });

      await expect(
        proc.createCheckoutSession({
          tenant: "t-1",
          amount: 9999 as unknown as import("../credit.js").Credit,
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
      ).rejects.toThrow();
    });
  });

  describe("handleWebhook", () => {
    it("verifies signature and processes event", async () => {
      const mockEvent = {
        id: "evt_123",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_abc",
            client_reference_id: "t-1",
            customer: "cus_abc123",
            amount_total: 1000,
            metadata: {},
          },
        },
      } as unknown as Stripe.Event;

      (stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(mockEvent);

      const mockLedger = {
        hasReferenceId: vi.fn().mockReturnValue(false),
        credit: vi.fn(),
        debit: vi.fn(),
        balance: vi.fn(),
        history: vi.fn(),
      };

      tenantStore.upsert.mockReturnValue(undefined);

      const proc = new StripePaymentProcessor({
        stripe,
        tenantStore,
        webhookSecret: "whsec_test",
        creditLedger: mockLedger as unknown as import("../credits/credit-ledger.js").ICreditLedger,
      });

      const result = await proc.handleWebhook(Buffer.from("raw-body"), "sig_header");

      expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(Buffer.from("raw-body"), "sig_header", "whsec_test");
      expect(result.eventType).toBe("checkout.session.completed");
    });

    it("throws on invalid signature", async () => {
      (stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Invalid signature");
      });

      await expect(processor.handleWebhook(Buffer.from("bad"), "bad_sig")).rejects.toThrow("Invalid signature");
    });
  });

  describe("createPortalSession", () => {
    it("creates portal session and returns url", async () => {
      tenantStore.getByTenant.mockReturnValue({
        tenant: "t-1",
        processor_customer_id: "cus_abc123",
      });
      const mockSession = { url: "https://billing.stripe.com/session_xyz" };
      (stripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const result = await processor.createPortalSession?.({
        tenant: "t-1",
        returnUrl: "https://example.com/billing",
      });

      expect(result?.url).toBe("https://billing.stripe.com/session_xyz");
    });

    it("throws when tenant has no Stripe customer", async () => {
      tenantStore.getByTenant.mockReturnValue(null);

      await expect(
        processor.createPortalSession?.({
          tenant: "t-unknown",
          returnUrl: "https://example.com/billing",
        }),
      ).rejects.toThrow();
    });
  });

  describe("setupPaymentMethod", () => {
    it("creates a SetupIntent and returns clientSecret", async () => {
      tenantStore.getByTenant.mockReturnValue({
        tenant: "t-1",
        processor_customer_id: "cus_abc123",
      });
      (stripe.setupIntents.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        client_secret: "seti_secret_abc",
      });

      const result = await processor.setupPaymentMethod("t-1");

      expect(result.clientSecret).toBe("seti_secret_abc");
    });
  });

  describe("listPaymentMethods", () => {
    it("returns mapped SavedPaymentMethod array", async () => {
      tenantStore.getByTenant.mockReturnValue({
        tenant: "t-1",
        processor_customer_id: "cus_abc123",
      });
      (stripe.customers.listPaymentMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: "pm_1",
            card: { brand: "visa", last4: "4242" },
            metadata: {},
          },
          {
            id: "pm_2",
            card: { brand: "mastercard", last4: "5555" },
            metadata: {},
          },
        ],
      });

      const methods = await processor.listPaymentMethods("t-1");

      expect(methods).toHaveLength(2);
      expect(methods[0].id).toBe("pm_1");
      expect(methods[0].label).toBe("Visa ending 4242");
      expect(methods[0].isDefault).toBe(true);
      expect(methods[1].id).toBe("pm_2");
      expect(methods[1].isDefault).toBe(false);
    });

    it("returns empty array when tenant has no Stripe customer", async () => {
      tenantStore.getByTenant.mockReturnValue(null);

      const methods = await processor.listPaymentMethods("t-unknown");
      expect(methods).toEqual([]);
    });
  });

  describe("charge", () => {
    it("charges and returns success result", async () => {
      tenantStore.getByTenant.mockReturnValue({
        tenant: "t-1",
        processor_customer_id: "cus_abc123",
      });
      (stripe.customers.listPaymentMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ id: "pm_1" }],
      });
      (stripe.paymentIntents.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "pi_123",
        status: "succeeded",
      });

      const mockLedger = {
        hasReferenceId: vi.fn().mockReturnValue(false),
        credit: vi.fn(),
        debit: vi.fn(),
        balance: vi.fn(),
        history: vi.fn(),
      };
      const mockEventLog = { writeEvent: vi.fn() };

      const proc = new StripePaymentProcessor({
        stripe,
        tenantStore,
        webhookSecret: "whsec_test",
        creditLedger: mockLedger as unknown as import("../credits/credit-ledger.js").ICreditLedger,
        autoTopupEventLog:
          mockEventLog as unknown as import("../credits/auto-topup-event-log-repository.js").IAutoTopupEventLogRepository,
      });

      const result = await proc.charge({
        tenant: "t-1",
        amount: 1000 as unknown as import("../credit.js").Credit,
        source: "auto_topup_usage",
      });

      expect(result.success).toBe(true);
      expect(result.paymentReference).toBe("pi_123");
    });
  });
});
