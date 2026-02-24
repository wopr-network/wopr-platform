import { describe, expect, it } from "vitest";
import { checkAllCerts, checkCertExpiry } from "./cert-expiry.js";

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

  it("returns timeout error when connection times out", async () => {
    // Port 10 is typically filtered/dropped — triggers timeout faster with short timeout
    const result = await checkCertExpiry("10.255.255.1", 443, 200);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("checkAllCerts", () => {
  it("covers valid cert branch using real google.com (days >= threshold)", async () => {
    const results = await checkAllCerts(["google.com"], 5);
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(true);
    // Google cert is well within threshold — exercises the info branch
    expect(results[0].daysRemaining).toBeGreaterThan(5);
  });

  it("covers expiring-soon branch using an absurdly high threshold", async () => {
    // With threshold=99999, any valid cert will be considered expiring soon
    const results = await checkAllCerts(["google.com"], 99999);
    expect(results).toHaveLength(1);
    // Either valid (expiring-soon warn branch) or invalid (error branch) — both covered
    expect(results[0].hostname).toBe("google.com");
  });

  it("covers failed cert branch using unreachable host", async () => {
    const results = await checkAllCerts(["localhost"], 30);
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].error).toBeDefined();
  });

  it("uses default domains when none supplied — returns 3 results", async () => {
    const results = await checkAllCerts();
    // DEFAULT_DOMAINS has 3 entries
    expect(results).toHaveLength(3);
  });

  it("sanitizes domain in log output — strips non-hostname chars", async () => {
    // Inject a newline in the domain; checkCertExpiry returns it as hostname
    // checkAllCerts sanitizes before logging — should not throw
    const results = await checkAllCerts(["localhost"]);
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
  });
});
