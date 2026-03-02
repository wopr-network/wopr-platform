import { describe, expect, it } from "vitest";
import { getCustomerTemplate, getInternalTemplate, type IncidentContext } from "./communication-templates.js";

function makeContext(overrides: Partial<IncidentContext> = {}): IncidentContext {
  return {
    incidentId: "INC-001",
    startedAt: new Date("2026-01-15T12:00:00Z"),
    affectedSystems: ["stripe-gateway", "credit-ledger"],
    customerImpact: "Some transactions may fail",
    currentStatus: "Investigating",
    ...overrides,
  };
}

describe("getCustomerTemplate", () => {
  it("returns customer audience for all severities", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const result = getCustomerTemplate(sev, makeContext());
      expect(result.audience).toBe("customer");
    }
  });

  it("SEV1 subject contains Action Required and incident ID", () => {
    const result = getCustomerTemplate("SEV1", makeContext());
    expect(result.subject).toContain("[Action Required]");
    expect(result.subject).toContain("INC-001");
  });

  it("SEV2 subject contains Notice and incident ID", () => {
    const result = getCustomerTemplate("SEV2", makeContext());
    expect(result.subject).toContain("[Notice]");
    expect(result.subject).toContain("INC-001");
  });

  it("SEV3 subject contains Notice and incident ID", () => {
    const result = getCustomerTemplate("SEV3", makeContext());
    expect(result.subject).toContain("[Notice]");
    expect(result.subject).toContain("INC-001");
  });

  it("body includes startedAt ISO string", () => {
    const result = getCustomerTemplate("SEV1", makeContext());
    expect(result.body).toContain("2026-01-15T12:00:00.000Z");
  });

  it("body includes customer impact and current status", () => {
    const ctx = makeContext({ customerImpact: "All payments blocked", currentStatus: "Mitigating" });
    const result = getCustomerTemplate("SEV1", ctx);
    expect(result.body).toContain("All payments blocked");
    expect(result.body).toContain("Mitigating");
  });
});

describe("getInternalTemplate", () => {
  it("returns internal audience for all severities", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const result = getInternalTemplate(sev, makeContext());
      expect(result.audience).toBe("internal");
    }
  });

  it("SEV1 internal subject contains SEV1 INCIDENT", () => {
    const result = getInternalTemplate("SEV1", makeContext());
    expect(result.subject).toContain("SEV1 INCIDENT");
    expect(result.subject).toContain("INC-001");
  });

  it("SEV2 internal subject contains SEV2 INCIDENT", () => {
    const result = getInternalTemplate("SEV2", makeContext());
    expect(result.subject).toContain("SEV2 INCIDENT");
  });

  it("SEV3 internal subject contains SEV3 WARNING", () => {
    const result = getInternalTemplate("SEV3", makeContext());
    expect(result.subject).toContain("SEV3 WARNING");
  });

  it("body includes affected systems as comma-separated list", () => {
    const result = getInternalTemplate("SEV1", makeContext());
    expect(result.body).toContain("stripe-gateway, credit-ledger");
  });

  it("body shows 'unknown' when affectedSystems is empty", () => {
    const result = getInternalTemplate("SEV1", makeContext({ affectedSystems: [] }));
    expect(result.body).toContain("unknown");
  });

  it("SEV1 body includes SLA times", () => {
    const result = getInternalTemplate("SEV1", makeContext());
    expect(result.body).toContain("ACK SLA: 5 minutes");
    expect(result.body).toContain("RESOLVE SLA: 60 minutes");
  });

  it("SEV2 body includes SLA times", () => {
    const result = getInternalTemplate("SEV2", makeContext());
    expect(result.body).toContain("ACK SLA: 15 minutes");
    expect(result.body).toContain("RESOLVE SLA: 4 hours");
  });

  it("SEV3 body includes SLA times", () => {
    const result = getInternalTemplate("SEV3", makeContext());
    expect(result.body).toContain("ACK SLA: 60 minutes");
    expect(result.body).toContain("RESOLVE SLA: 24 hours");
  });
});
