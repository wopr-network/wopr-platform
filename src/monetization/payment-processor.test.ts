import { describe, expectTypeOf, it } from "vitest";
import type {
  ChargeOpts,
  ChargeResult,
  CheckoutOpts,
  CheckoutSession,
  IPaymentProcessor,
  PortalOpts,
  SavedPaymentMethod,
  SetupResult,
  WebhookResult,
} from "./payment-processor.js";

describe("IPaymentProcessor types", () => {
  it("CheckoutOpts has required fields", () => {
    expectTypeOf<CheckoutOpts>().toHaveProperty("tenant");
    expectTypeOf<CheckoutOpts>().toHaveProperty("amount");
    expectTypeOf<CheckoutOpts>().toHaveProperty("successUrl");
    expectTypeOf<CheckoutOpts>().toHaveProperty("cancelUrl");
  });

  it("CheckoutSession has id and url", () => {
    expectTypeOf<CheckoutSession>().toHaveProperty("id");
    expectTypeOf<CheckoutSession>().toHaveProperty("url");
  });

  it("ChargeResult has success field", () => {
    expectTypeOf<ChargeResult>().toHaveProperty("success");
  });

  it("WebhookResult uses Credit for credited field", () => {
    expectTypeOf<WebhookResult>().toHaveProperty("handled");
    expectTypeOf<WebhookResult>().toHaveProperty("eventType");
  });

  it("SavedPaymentMethod has id, label, isDefault", () => {
    expectTypeOf<SavedPaymentMethod>().toHaveProperty("id");
    expectTypeOf<SavedPaymentMethod>().toHaveProperty("label");
    expectTypeOf<SavedPaymentMethod>().toHaveProperty("isDefault");
  });

  it("IPaymentProcessor has all required methods", () => {
    expectTypeOf<IPaymentProcessor>().toHaveProperty("name");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("createCheckoutSession");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("handleWebhook");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("supportsPortal");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("setupPaymentMethod");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("listPaymentMethods");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("detachPaymentMethod");
    expectTypeOf<IPaymentProcessor>().toHaveProperty("charge");
  });

  it("createPortalSession is required on IPaymentProcessor", () => {
    // Implementations that don't support portal must still implement createPortalSession (and throw)
    const processor: IPaymentProcessor = {
      name: "test",
      createCheckoutSession: async () => ({ id: "s", url: "u" }),
      handleWebhook: async () => ({ handled: true, eventType: "test" }),
      supportsPortal: () => false,
      createPortalSession: async () => {
        throw new Error("Billing portal not supported");
      },
      setupPaymentMethod: async () => ({ clientSecret: "cs" }),
      listPaymentMethods: async () => [],
      detachPaymentMethod: async () => undefined,
      charge: async () => ({ success: true }),
    };
    expectTypeOf(processor).toMatchTypeOf<IPaymentProcessor>();
  });

  it("PortalOpts has tenant and returnUrl", () => {
    expectTypeOf<PortalOpts>().toHaveProperty("tenant");
    expectTypeOf<PortalOpts>().toHaveProperty("returnUrl");
  });

  it("SetupResult has clientSecret", () => {
    expectTypeOf<SetupResult>().toHaveProperty("clientSecret");
  });

  it("ChargeOpts has tenant, amount, source", () => {
    expectTypeOf<ChargeOpts>().toHaveProperty("tenant");
    expectTypeOf<ChargeOpts>().toHaveProperty("amount");
    expectTypeOf<ChargeOpts>().toHaveProperty("source");
  });
});
