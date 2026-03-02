import { describe, expect, it } from "vitest";
import { classifySeverity, type SeveritySignals } from "./severity.js";

function healthy(): SeveritySignals {
  return {
    stripeReachable: true,
    webhooksReceiving: true,
    gatewayErrorRate: 0,
    creditDeductionFailures: 0,
    dlqDepth: 0,
    tenantsWithNegativeBalance: 0,
    autoTopupFailures: 0,
    firingAlertCount: 0,
  };
}

describe("classifySeverity", () => {
  describe("healthy (no incident)", () => {
    it("returns SEV3 with no reasons when all signals are healthy", () => {
      const result = classifySeverity(healthy());
      expect(result.severity).toBe("SEV3");
      expect(result.reasons).toHaveLength(0);
    });

    it("treats webhooksReceiving: null as not monitored (skips check)", () => {
      const result = classifySeverity({ ...healthy(), webhooksReceiving: null });
      expect(result.severity).toBe("SEV3");
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe("SEV1 — total payment outage", () => {
    it("returns SEV1 when Stripe is unreachable", () => {
      const result = classifySeverity({ ...healthy(), stripeReachable: false });
      expect(result.severity).toBe("SEV1");
      expect(result.reasons).toContain("Stripe API unreachable");
    });

    it("returns SEV1 when webhooks stopped", () => {
      const result = classifySeverity({ ...healthy(), webhooksReceiving: false });
      expect(result.severity).toBe("SEV1");
      expect(result.reasons[0]).toContain("No webhook events");
    });

    it("returns SEV1 when gateway error rate exceeds 50%", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.51 });
      expect(result.severity).toBe("SEV1");
      expect(result.reasons[0]).toContain("51.0%");
    });

    it("returns SEV1 when 3 or more alerts firing", () => {
      const result = classifySeverity({ ...healthy(), firingAlertCount: 3 });
      expect(result.severity).toBe("SEV1");
      expect(result.reasons[0]).toContain("3 alerts firing");
    });

    it("collects multiple SEV1 reasons", () => {
      const result = classifySeverity({
        ...healthy(),
        stripeReachable: false,
        webhooksReceiving: false,
        gatewayErrorRate: 0.6,
        firingAlertCount: 5,
      });
      expect(result.severity).toBe("SEV1");
      expect(result.reasons).toHaveLength(4);
    });
  });

  describe("SEV1 boundary conditions", () => {
    it("gateway error rate exactly 0.5 is NOT SEV1", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.5 });
      expect(result.severity).not.toBe("SEV1");
    });

    it("firingAlertCount 2 is NOT SEV1", () => {
      const result = classifySeverity({ ...healthy(), firingAlertCount: 2 });
      expect(result.severity).not.toBe("SEV1");
    });
  });

  describe("SEV2 — degraded", () => {
    it("returns SEV2 when 1 alert firing", () => {
      const result = classifySeverity({ ...healthy(), firingAlertCount: 1 });
      expect(result.severity).toBe("SEV2");
      expect(result.reasons[0]).toContain("1 alert(s) firing");
    });

    it("returns SEV2 when credit deduction failures exceed 10", () => {
      const result = classifySeverity({ ...healthy(), creditDeductionFailures: 11 });
      expect(result.severity).toBe("SEV2");
      expect(result.reasons[0]).toContain("Credit deduction failures");
    });

    it("returns SEV2 when DLQ depth exceeds 50", () => {
      const result = classifySeverity({ ...healthy(), dlqDepth: 51 });
      expect(result.severity).toBe("SEV2");
      expect(result.reasons[0]).toContain("Meter DLQ depth");
    });

    it("returns SEV2 when auto-topup failures reach 3", () => {
      const result = classifySeverity({ ...healthy(), autoTopupFailures: 3 });
      expect(result.severity).toBe("SEV2");
      expect(result.reasons[0]).toContain("Auto-topup");
    });

    it("returns SEV2 when gateway error rate in 5-50% range", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.1 });
      expect(result.severity).toBe("SEV2");
      expect(result.reasons[0]).toContain("10.0%");
    });

    it("gateway error rate exactly 0.05 is NOT SEV2 degraded range", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.05 });
      // 0.05 is not > 0.05, so no SEV2 gateway trigger — falls to SEV3 (> 0.02)
      expect(result.severity).not.toBe("SEV2");
      expect(result.severity).toBe("SEV3");
    });
  });

  describe("SEV2 boundary conditions", () => {
    it("creditDeductionFailures exactly 10 is NOT SEV2", () => {
      const result = classifySeverity({ ...healthy(), creditDeductionFailures: 10 });
      expect(result.severity).not.toBe("SEV2");
    });

    it("dlqDepth exactly 50 is NOT SEV2", () => {
      const result = classifySeverity({ ...healthy(), dlqDepth: 50 });
      expect(result.severity).not.toBe("SEV2");
    });

    it("autoTopupFailures 2 is NOT SEV2", () => {
      const result = classifySeverity({ ...healthy(), autoTopupFailures: 2 });
      expect(result.severity).not.toBe("SEV2");
    });

    it("gateway error rate 0.5 (exactly 50%) is SEV2 not SEV1", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.5 });
      expect(result.severity).toBe("SEV2");
      expect(result.reasons[0]).toContain("50.0%");
    });
  });

  describe("SEV3 — warning", () => {
    it("returns SEV3 when DLQ depth > 0 but <= 50", () => {
      const result = classifySeverity({ ...healthy(), dlqDepth: 1 });
      expect(result.severity).toBe("SEV3");
      expect(result.reasons[0]).toContain("1 pending event");
    });

    it("returns SEV3 when credit deduction failures > 0 but <= 10", () => {
      const result = classifySeverity({ ...healthy(), creditDeductionFailures: 1 });
      expect(result.severity).toBe("SEV3");
      expect(result.reasons[0]).toContain("1 credit deduction failure");
    });

    it("returns SEV3 when gateway error rate above 2% but <= 5%", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.03 });
      expect(result.severity).toBe("SEV3");
      expect(result.reasons[0]).toContain("3.0%");
    });

    it("returns SEV3 when more than 5 tenants with negative balance", () => {
      const result = classifySeverity({ ...healthy(), tenantsWithNegativeBalance: 6 });
      expect(result.severity).toBe("SEV3");
      expect(result.reasons[0]).toContain("6 tenants");
    });

    it("gateway error rate exactly 0.02 is NOT SEV3", () => {
      const result = classifySeverity({ ...healthy(), gatewayErrorRate: 0.02 });
      expect(result.reasons).toHaveLength(0);
    });

    it("tenantsWithNegativeBalance exactly 5 is NOT SEV3", () => {
      const result = classifySeverity({ ...healthy(), tenantsWithNegativeBalance: 5 });
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe("SEV1 takes priority over SEV2 and SEV3", () => {
    it("returns SEV1 even when SEV2 and SEV3 conditions also met", () => {
      const result = classifySeverity({
        stripeReachable: false,
        webhooksReceiving: false,
        gatewayErrorRate: 0.6,
        creditDeductionFailures: 20,
        dlqDepth: 100,
        tenantsWithNegativeBalance: 10,
        autoTopupFailures: 5,
        firingAlertCount: 5,
      });
      expect(result.severity).toBe("SEV1");
    });
  });
});
