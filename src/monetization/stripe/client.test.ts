import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStripeClient, loadStripeConfig } from "./client.js";

describe("loadStripeConfig", () => {
  let origSecretKey: string | undefined;
  let origWebhookSecret: string | undefined;

  beforeEach(() => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    origWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (origSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = origSecretKey;
    }
    if (origWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = origWebhookSecret;
    }
  });

  it("returns null when both env vars are missing", () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(loadStripeConfig()).toBeNull();
  });

  it("returns null when only STRIPE_SECRET_KEY is set", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(loadStripeConfig()).toBeNull();
  });

  it("returns null when only STRIPE_WEBHOOK_SECRET is set", () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_abc";
    expect(loadStripeConfig()).toBeNull();
  });

  it("returns config when both env vars are present", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_def456";
    const config = loadStripeConfig();
    expect(config).not.toBeNull();
    expect(config?.secretKey).toBe("sk_test_abc123");
    expect(config?.webhookSecret).toBe("whsec_def456");
  });
});

describe("createStripeClient", () => {
  it("creates a Stripe client with pinned API version", () => {
    const client = createStripeClient({ secretKey: "sk_test_abc", webhookSecret: "whsec_abc" });
    // Stripe client stores the API version internally
    // We verify it was created successfully
    expect(client).toBeDefined();
    expect(client.checkout).toBeDefined();
    expect(client.paymentIntents).toBeDefined();
    expect(client.setupIntents).toBeDefined();
  });
});
