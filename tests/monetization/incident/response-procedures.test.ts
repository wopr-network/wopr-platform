import { describe, expect, it } from "vitest";
import { getResponseProcedure } from "../../../src/monetization/incident/response-procedures.js";

describe("getResponseProcedure", () => {
  it("returns SEV1 procedure with 5min ack SLA", () => {
    const proc = getResponseProcedure("SEV1");
    expect(proc.severity).toBe("SEV1");
    expect(proc.slaAcknowledgeMinutes).toBe(5);
    expect(proc.steps.length).toBeGreaterThan(0);
    expect(proc.steps[0].order).toBe(1);
  });

  it("returns SEV2 procedure with 15min ack SLA", () => {
    const proc = getResponseProcedure("SEV2");
    expect(proc.severity).toBe("SEV2");
    expect(proc.slaAcknowledgeMinutes).toBe(15);
  });

  it("returns SEV3 procedure with 60min ack SLA", () => {
    const proc = getResponseProcedure("SEV3");
    expect(proc.severity).toBe("SEV3");
    expect(proc.slaAcknowledgeMinutes).toBe(60);
  });

  it("SEV1 steps include Stripe status check", () => {
    const proc = getResponseProcedure("SEV1");
    const hasStripeCheck = proc.steps.some((s) => s.action.toLowerCase().includes("stripe"));
    expect(hasStripeCheck).toBe(true);
  });

  it("steps are ordered sequentially starting at 1", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const proc = getResponseProcedure(sev);
      proc.steps.forEach((step, i) => {
        expect(step.order).toBe(i + 1);
      });
    }
  });

  it("each step has an owner and action", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const proc = getResponseProcedure(sev);
      for (const step of proc.steps) {
        expect(step.owner).toBeTruthy();
        expect(step.action).toBeTruthy();
      }
    }
  });

  it("SEV1 has shorter resolve SLA than SEV2", () => {
    const sev1 = getResponseProcedure("SEV1");
    const sev2 = getResponseProcedure("SEV2");
    expect(sev1.slaResolveMinutes).toBeLessThan(sev2.slaResolveMinutes);
  });
});
