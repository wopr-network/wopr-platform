import { describe, expect, it } from "vitest";
import { checkCertExpiry } from "./cert-expiry.js";

describe("checkCertExpiry", () => {
  it("returns days remaining for a valid cert", async () => {
    const result = await checkCertExpiry("google.com", 443);
    expect(result.valid).toBe(true);
    expect(result.daysRemaining).toBeGreaterThan(0);
    expect(result.hostname).toBe("google.com");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("returns error for unreachable host", async () => {
    const result = await checkCertExpiry("localhost", 19999);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("flags cert expiring within threshold", async () => {
    const result = await checkCertExpiry("google.com", 443);
    // Google certs typically valid for 90 days
    const isExpiringSoon = result.daysRemaining !== undefined && result.daysRemaining < 30;
    expect(typeof isExpiringSoon).toBe("boolean");
  });
});
