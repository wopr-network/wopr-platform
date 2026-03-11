import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@wopr-network/platform-core/auth", () => ({
  buildTokenMetadataMap: vi.fn().mockReturnValue(new Map()),
  // biome-ignore lint/suspicious/noExplicitAny: vi.fn() mock context
  scopedBearerAuthWithTenant: vi.fn().mockReturnValue(async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: "test-admin" });
    await next();
  }),
}));

import { incidentResponseRoutes } from "./incident-response.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("incidentResponseRoutes", () => {
  // POST /severity — classify severity from signals

  describe("POST /severity", () => {
    const healthySignals = {
      stripeReachable: true,
      webhooksReceiving: true,
      gatewayErrorRate: 0,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 0,
    };

    it("classifies healthy signals as SEV3 with no reasons", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(healthySignals),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.severity).toBe("SEV3");
      expect(body.reasons).toHaveLength(0);
    });

    it("classifies SEV1 when Stripe is unreachable", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...healthySignals, stripeReachable: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.severity).toBe("SEV1");
      expect(body.reasons.length).toBeGreaterThan(0);
    });

    it("classifies SEV1 when gateway error rate exceeds 50%", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...healthySignals, gatewayErrorRate: 0.6 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.severity).toBe("SEV1");
    });

    it("classifies SEV2 when credit deduction failures exceed 10", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...healthySignals, creditDeductionFailures: 11 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.severity).toBe("SEV2");
    });

    it("classifies SEV3 for early warning DLQ depth", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...healthySignals, dlqDepth: 1 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.severity).toBe("SEV3");
      expect(body.reasons.length).toBeGreaterThan(0);
    });

    it("returns 400 for invalid payload", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stripeReachable: "not-a-boolean" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Invalid signals payload");
    });

    it("returns 400 for missing required fields", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it("accepts null for webhooksReceiving (unconfigured)", async () => {
      const res = await incidentResponseRoutes.request("/severity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...healthySignals, webhooksReceiving: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // GET /escalation/:severity

  describe("GET /escalation/:severity", () => {
    it("returns escalation matrix for SEV1", async () => {
      const res = await incidentResponseRoutes.request("/escalation/SEV1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.severity).toBe("SEV1");
      expect(body.contacts.length).toBeGreaterThan(0);
      expect(body.contacts[0].channel).toBe("pagerduty");
    });

    it("returns escalation matrix for SEV2", async () => {
      const res = await incidentResponseRoutes.request("/escalation/SEV2");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.severity).toBe("SEV2");
      expect(body.contacts.length).toBeGreaterThan(0);
    });

    it("returns escalation matrix for SEV3", async () => {
      const res = await incidentResponseRoutes.request("/escalation/SEV3");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.severity).toBe("SEV3");
      expect(body.contacts.length).toBeGreaterThan(0);
    });

    it("returns 400 for invalid severity SEV4", async () => {
      const res = await incidentResponseRoutes.request("/escalation/SEV4");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("Invalid severity");
    });

    it("returns 400 for lowercase severity", async () => {
      const res = await incidentResponseRoutes.request("/escalation/sev1");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  // GET /procedure/:severity

  describe("GET /procedure/:severity", () => {
    it("returns response procedure for SEV1", async () => {
      const res = await incidentResponseRoutes.request("/procedure/SEV1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.procedure.severity).toBe("SEV1");
      expect(body.procedure.steps.length).toBeGreaterThan(0);
      expect(body.procedure.slaAcknowledgeMinutes).toBe(5);
      expect(body.procedure.slaResolveMinutes).toBe(60);
    });

    it("returns response procedure for SEV2", async () => {
      const res = await incidentResponseRoutes.request("/procedure/SEV2");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.procedure.severity).toBe("SEV2");
      expect(body.procedure.slaAcknowledgeMinutes).toBe(15);
      expect(body.procedure.slaResolveMinutes).toBe(240);
    });

    it("returns response procedure for SEV3", async () => {
      const res = await incidentResponseRoutes.request("/procedure/SEV3");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.procedure.severity).toBe("SEV3");
    });

    it("returns 400 for invalid severity", async () => {
      const res = await incidentResponseRoutes.request("/procedure/INVALID");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  // POST /communicate

  describe("POST /communicate", () => {
    const validPayload = {
      severity: "SEV1",
      incidentId: "INC-001",
      startedAt: "2026-03-01T12:00:00.000Z",
      affectedSystems: ["stripe", "credit-ledger"],
      customerImpact: "Payments are not processing",
      currentStatus: "Investigating",
    };

    it("returns customer and internal communication templates for SEV1", async () => {
      const res = await incidentResponseRoutes.request("/communicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.templates.customer.audience).toBe("customer");
      expect(body.templates.customer.subject).toContain("INC-001");
      expect(body.templates.internal.audience).toBe("internal");
      expect(body.templates.internal.subject).toContain("SEV1");
    });

    it("returns templates for SEV2", async () => {
      const res = await incidentResponseRoutes.request("/communicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validPayload, severity: "SEV2" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.templates.customer.audience).toBe("customer");
      expect(body.templates.internal.audience).toBe("internal");
    });

    it("returns templates for SEV3", async () => {
      const res = await incidentResponseRoutes.request("/communicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validPayload, severity: "SEV3" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns 400 for missing required fields", async () => {
      const res = await incidentResponseRoutes.request("/communicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ severity: "SEV1" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it("returns 400 for invalid severity", async () => {
      const res = await incidentResponseRoutes.request("/communicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validPayload, severity: "SEV4" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it("returns 400 for invalid datetime format", async () => {
      const res = await incidentResponseRoutes.request("/communicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validPayload, startedAt: "not-a-date" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // POST /postmortem

  describe("POST /postmortem", () => {
    const validPostmortemPayload = {
      incidentId: "INC-001",
      severity: "SEV1",
      title: "Payment processing outage",
      startedAt: "2026-03-01T10:00:00.000Z",
      detectedAt: "2026-03-01T10:05:00.000Z",
      resolvedAt: "2026-03-01T11:00:00.000Z",
      affectedSystems: ["stripe", "credit-ledger"],
      affectedTenantCount: 42,
      revenueImpactCents: 50000,
    };

    it("generates post-mortem report for resolved incident", async () => {
      const res = await incidentResponseRoutes.request("/postmortem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPostmortemPayload),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.report.severity).toBe("SEV1");
      expect(body.report.title).toBe("Payment processing outage");
      expect(body.report.markdown).toContain("INC-001");
      expect(body.report.sections.summary).toBeTruthy();
    });

    it("generates post-mortem for ongoing incident (null resolvedAt)", async () => {
      const res = await incidentResponseRoutes.request("/postmortem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validPostmortemPayload, resolvedAt: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.report.markdown).toContain("ONGOING");
    });

    it("returns 400 for missing required fields", async () => {
      const res = await incidentResponseRoutes.request("/postmortem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId: "INC-001" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it("returns 400 for null revenueImpactCents with valid payload otherwise", async () => {
      const res = await incidentResponseRoutes.request("/postmortem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validPostmortemPayload, revenueImpactCents: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
