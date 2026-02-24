import { describe, expect, it } from "vitest";
import {
  getCustomerTemplate,
  getInternalTemplate,
  type IncidentContext,
} from "../../../src/monetization/incident/communication-templates.js";

const ctx: IncidentContext = {
  incidentId: "INC-001",
  startedAt: new Date("2026-02-24T10:00:00Z"),
  affectedSystems: ["stripe-webhooks", "credit-ledger"],
  customerImpact: "Payment processing unavailable",
  currentStatus: "Investigating",
};

describe("getCustomerTemplate", () => {
  it("returns customer audience for all severities", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      expect(getCustomerTemplate(sev, ctx).audience).toBe("customer");
    }
  });

  it("SEV1 subject contains incident ID", () => {
    const tmpl = getCustomerTemplate("SEV1", ctx);
    expect(tmpl.subject).toContain("INC-001");
  });

  it("SEV1 body contains customer impact", () => {
    const tmpl = getCustomerTemplate("SEV1", ctx);
    expect(tmpl.body).toContain(ctx.customerImpact);
  });

  it("SEV1 body contains current status", () => {
    const tmpl = getCustomerTemplate("SEV1", ctx);
    expect(tmpl.body).toContain(ctx.currentStatus);
  });

  it("returns different subjects for different severities", () => {
    const sev1 = getCustomerTemplate("SEV1", ctx);
    const sev2 = getCustomerTemplate("SEV2", ctx);
    const sev3 = getCustomerTemplate("SEV3", ctx);
    expect(sev1.subject).not.toBe(sev2.subject);
    expect(sev2.subject).not.toBe(sev3.subject);
  });
});

describe("getInternalTemplate", () => {
  it("returns internal audience for all severities", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      expect(getInternalTemplate(sev, ctx).audience).toBe("internal");
    }
  });

  it("SEV1 internal body includes immediate action instructions", () => {
    const tmpl = getInternalTemplate("SEV1", ctx);
    expect(tmpl.body).toContain("IMMEDIATE");
  });

  it("SEV1 internal subject includes severity label", () => {
    const tmpl = getInternalTemplate("SEV1", ctx);
    expect(tmpl.subject).toContain("SEV1");
  });

  it("internal template includes affected systems", () => {
    const tmpl = getInternalTemplate("SEV2", ctx);
    expect(tmpl.body).toContain("stripe-webhooks");
  });

  it("internal template includes SLA information", () => {
    const tmpl = getInternalTemplate("SEV1", ctx);
    expect(tmpl.body).toContain("SLA");
  });
});
