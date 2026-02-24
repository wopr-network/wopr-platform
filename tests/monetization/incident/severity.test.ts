import { describe, expect, it } from "vitest";
import { classifySeverity, type SeveritySignals } from "../../../src/monetization/incident/severity.js";

const healthy: SeveritySignals = {
  stripeReachable: true,
  webhooksReceiving: true,
  gatewayErrorRate: 0,
  creditDeductionFailures: 0,
  dlqDepth: 0,
  tenantsWithNegativeBalance: 0,
  autoTopupFailures: 0,
  firingAlertCount: 0,
};

describe("classifySeverity", () => {
  it("returns SEV3 with no reasons when all healthy", () => {
    const result = classifySeverity(healthy);
    expect(result.severity).toBe("SEV3");
    expect(result.reasons).toHaveLength(0);
  });

  it("returns SEV1 when Stripe unreachable", () => {
    const result = classifySeverity({ ...healthy, stripeReachable: false });
    expect(result.severity).toBe("SEV1");
    expect(result.reasons.some((r) => r.includes("Stripe"))).toBe(true);
  });

  it("returns SEV1 when webhooks not receiving", () => {
    const result = classifySeverity({ ...healthy, webhooksReceiving: false });
    expect(result.severity).toBe("SEV1");
    expect(result.reasons.some((r) => r.includes("webhook"))).toBe(true);
  });

  it("returns SEV1 when gateway error rate > 50%", () => {
    const result = classifySeverity({ ...healthy, gatewayErrorRate: 0.6 });
    expect(result.severity).toBe("SEV1");
  });

  it("returns SEV2 when credit deduction failures > 10", () => {
    const result = classifySeverity({ ...healthy, creditDeductionFailures: 11 });
    expect(result.severity).toBe("SEV2");
    expect(result.reasons.some((r) => r.includes("deduction"))).toBe(true);
  });

  it("returns SEV2 when DLQ depth > 50", () => {
    const result = classifySeverity({ ...healthy, dlqDepth: 51 });
    expect(result.severity).toBe("SEV2");
    expect(result.reasons.some((r) => r.includes("DLQ"))).toBe(true);
  });

  it("returns SEV2 when auto-topup failures >= 3", () => {
    const result = classifySeverity({ ...healthy, autoTopupFailures: 3 });
    expect(result.severity).toBe("SEV2");
  });

  it("returns SEV2 when gateway error rate between 5% and 50%", () => {
    const result = classifySeverity({ ...healthy, gatewayErrorRate: 0.1 });
    expect(result.severity).toBe("SEV2");
  });

  it("returns SEV3 when DLQ has items", () => {
    const result = classifySeverity({ ...healthy, dlqDepth: 1 });
    expect(result.severity).toBe("SEV3");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns SEV3 when gateway error rate > 2%", () => {
    const result = classifySeverity({ ...healthy, gatewayErrorRate: 0.03 });
    expect(result.severity).toBe("SEV3");
  });

  it("returns SEV3 when negative balance tenants > 5", () => {
    const result = classifySeverity({ ...healthy, tenantsWithNegativeBalance: 6 });
    expect(result.severity).toBe("SEV3");
  });
});
