/**
 * Tests for Twilio webhook signature verification.
 *
 * Test vectors from Twilio documentation:
 * https://www.twilio.com/docs/usage/security#validating-requests
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTwilioSignature } from "./twilio-signature.js";

// Twilio's official test vector from docs
const TEST_AUTH_TOKEN = "12345";
const TEST_URL = "https://mycompany.com/myapp?foo=1&bar=2";
const TEST_PARAMS = {
  CallSid: "CA1234567890ABCDE",
  Caller: "+14158675309",
  Digits: "1234",
  From: "+14158675309",
  To: "+18005551212",
};

// Compute the expected signature using the known algorithm
function computeExpectedSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}

describe("validateTwilioSignature", () => {
  it("returns true for a valid signature matching the Twilio algorithm", () => {
    const signature = computeExpectedSignature(TEST_AUTH_TOKEN, TEST_URL, TEST_PARAMS);
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, signature, TEST_URL, TEST_PARAMS)).toBe(true);
  });

  it("returns true with empty params", () => {
    const signature = computeExpectedSignature(TEST_AUTH_TOKEN, TEST_URL, {});
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, signature, TEST_URL, {})).toBe(true);
  });

  it("sorts params alphabetically before hashing", () => {
    // Params in reverse alphabetical order — the function must sort them
    const params = { Zzz: "last", Aaa: "first", Mmm: "middle" };
    const signature = computeExpectedSignature(TEST_AUTH_TOKEN, TEST_URL, params);
    // Pass in scrambled order — should still match
    const scrambled = { Mmm: "middle", Aaa: "first", Zzz: "last" };
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, signature, TEST_URL, scrambled)).toBe(true);
  });

  it("returns false for a tampered signature", () => {
    const signature = computeExpectedSignature(TEST_AUTH_TOKEN, TEST_URL, TEST_PARAMS);
    const tampered = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, tampered, TEST_URL, TEST_PARAMS)).toBe(false);
  });

  it("returns false for a wrong auth token", () => {
    const signature = computeExpectedSignature(TEST_AUTH_TOKEN, TEST_URL, TEST_PARAMS);
    expect(validateTwilioSignature("wrongtoken", signature, TEST_URL, TEST_PARAMS)).toBe(false);
  });

  it("returns false when URL does not match", () => {
    const signature = computeExpectedSignature(TEST_AUTH_TOKEN, TEST_URL, TEST_PARAMS);
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, signature, "https://other.example.com/webhook", TEST_PARAMS)).toBe(
      false,
    );
  });

  it("returns false for different-length signatures (timing-safe)", () => {
    // A signature that is a different length from the expected base64 output
    const shortSignature = "abc";
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, shortSignature, TEST_URL, TEST_PARAMS)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(validateTwilioSignature(TEST_AUTH_TOKEN, "", TEST_URL, TEST_PARAMS)).toBe(false);
  });
});
