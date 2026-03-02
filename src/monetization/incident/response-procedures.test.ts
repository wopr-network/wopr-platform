import { describe, expect, it } from "vitest";
import { getResponseProcedure } from "./response-procedures.js";

describe("getResponseProcedure", () => {
  it("returns SEV1 procedure with correct SLAs", () => {
    const proc = getResponseProcedure("SEV1");
    expect(proc.severity).toBe("SEV1");
    expect(proc.slaAcknowledgeMinutes).toBe(5);
    expect(proc.slaResolveMinutes).toBe(60);
    expect(proc.summary).toContain("Total payment outage");
  });

  it("SEV1 has 10 ordered steps", () => {
    const proc = getResponseProcedure("SEV1");
    expect(proc.steps).toHaveLength(10);
    for (let i = 0; i < proc.steps.length; i++) {
      expect(proc.steps[i].order).toBe(i + 1);
    }
  });

  it("returns SEV2 procedure with correct SLAs", () => {
    const proc = getResponseProcedure("SEV2");
    expect(proc.severity).toBe("SEV2");
    expect(proc.slaAcknowledgeMinutes).toBe(15);
    expect(proc.slaResolveMinutes).toBe(240);
    expect(proc.summary).toContain("Degraded");
  });

  it("SEV2 has 7 ordered steps", () => {
    const proc = getResponseProcedure("SEV2");
    expect(proc.steps).toHaveLength(7);
    for (let i = 0; i < proc.steps.length; i++) {
      expect(proc.steps[i].order).toBe(i + 1);
    }
  });

  it("returns SEV3 procedure with correct SLAs", () => {
    const proc = getResponseProcedure("SEV3");
    expect(proc.severity).toBe("SEV3");
    expect(proc.slaAcknowledgeMinutes).toBe(60);
    expect(proc.slaResolveMinutes).toBe(1440);
    expect(proc.summary).toContain("Early warning");
  });

  it("SEV3 has 5 ordered steps", () => {
    const proc = getResponseProcedure("SEV3");
    expect(proc.steps).toHaveLength(5);
    for (let i = 0; i < proc.steps.length; i++) {
      expect(proc.steps[i].order).toBe(i + 1);
    }
  });

  it("every step has action, owner, and order", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const proc = getResponseProcedure(sev);
      for (const step of proc.steps) {
        expect(step.action).toBeTruthy();
        expect(step.owner).toBeTruthy();
        expect(step.order).toBeGreaterThan(0);
      }
    }
  });

  it("SLA escalation: SEV1 < SEV2 < SEV3 for both ack and resolve", () => {
    const sev1 = getResponseProcedure("SEV1");
    const sev2 = getResponseProcedure("SEV2");
    const sev3 = getResponseProcedure("SEV3");
    expect(sev1.slaAcknowledgeMinutes).toBeLessThan(sev2.slaAcknowledgeMinutes);
    expect(sev2.slaAcknowledgeMinutes).toBeLessThan(sev3.slaAcknowledgeMinutes);
    expect(sev1.slaResolveMinutes).toBeLessThan(sev2.slaResolveMinutes);
    expect(sev2.slaResolveMinutes).toBeLessThan(sev3.slaResolveMinutes);
  });
});
