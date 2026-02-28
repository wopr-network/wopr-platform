import { describe, expect, it } from "vitest";
import { checkSelfReferral, type FraudSignalBundle, normalizeEmail } from "./self-referral-detector.js";

const BASE_BUNDLE: FraudSignalBundle = {
  referrerTenantId: "t-a",
  referredTenantId: "t-b",
  referralId: "ref-1",
  referredIp: null,
  referredEmail: null,
  existingReferrals: [],
  referrerIp: null,
  referrerEmail: null,
  referrerStripeCustomerId: null,
  referredStripeCustomerId: null,
};

describe("normalizeEmail", () => {
  it("lowercases", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("strips gmail dots", () => {
    expect(normalizeEmail("u.s.e.r@gmail.com")).toBe("user@gmail.com");
  });

  it("strips gmail plus aliases", () => {
    expect(normalizeEmail("user+ref@gmail.com")).toBe("user@gmail.com");
  });

  it("strips dots and plus for googlemail.com", () => {
    expect(normalizeEmail("u.ser+tag@googlemail.com")).toBe("user@googlemail.com");
  });

  it("does NOT strip dots/plus for non-gmail domains", () => {
    expect(normalizeEmail("u.ser+tag@company.com")).toBe("u.ser+tag@company.com");
  });

  it("returns null for null input", () => {
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("checkSelfReferral", () => {
  it("returns clean when no signals present", () => {
    const result = checkSelfReferral(BASE_BUNDLE);
    expect(result.verdict).toBe("clean");
    expect(result.signals).toHaveLength(0);
  });

  it("flags when referrer and referred share same IP", () => {
    const result = checkSelfReferral({
      ...BASE_BUNDLE,
      referrerIp: "1.2.3.4",
      referredIp: "1.2.3.4",
    });
    expect(result.verdict).toBe("flagged");
    expect(result.signals).toContain("same_ip");
  });

  it("blocks when 2+ signals match (IP + email alias)", () => {
    const result = checkSelfReferral({
      ...BASE_BUNDLE,
      referrerIp: "1.2.3.4",
      referredIp: "1.2.3.4",
      referrerEmail: "alice@gmail.com",
      referredEmail: "alice+ref@gmail.com",
    });
    expect(result.verdict).toBe("blocked");
    expect(result.signals).toContain("same_ip");
    expect(result.signals).toContain("email_alias");
  });

  it("blocks when Stripe customer IDs match", () => {
    const result = checkSelfReferral({
      ...BASE_BUNDLE,
      referrerStripeCustomerId: "cus_abc",
      referredStripeCustomerId: "cus_abc",
    });
    expect(result.verdict).toBe("blocked");
    expect(result.signals).toContain("same_stripe_customer");
  });

  it("flags when referred IP matches an existing referral's IP", () => {
    const result = checkSelfReferral({
      ...BASE_BUNDLE,
      referredIp: "10.0.0.1",
      existingReferrals: [{ referredTenantId: "t-c", signupIp: "10.0.0.1", signupEmail: null }],
    });
    expect(result.verdict).toBe("flagged");
    expect(result.signals).toContain("ip_reuse_across_referrals");
  });

  it("blocks when referred IP matches referrer AND existing referral (2 signals)", () => {
    const result = checkSelfReferral({
      ...BASE_BUNDLE,
      referrerIp: "10.0.0.1",
      referredIp: "10.0.0.1",
      existingReferrals: [{ referredTenantId: "t-c", signupIp: "10.0.0.1", signupEmail: null }],
    });
    expect(result.verdict).toBe("blocked");
    expect(result.signals).toContain("same_ip");
    expect(result.signals).toContain("ip_reuse_across_referrals");
  });
});
