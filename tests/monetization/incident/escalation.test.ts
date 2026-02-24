import { describe, expect, it } from "vitest";
import { getEscalationMatrix } from "../../../src/monetization/incident/escalation.js";

describe("getEscalationMatrix", () => {
  it("returns contacts ordered starting at 1", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const contacts = getEscalationMatrix(sev);
      expect(contacts.length).toBeGreaterThan(0);
      contacts.forEach((c, i) => {
        expect(c.order).toBe(i + 1);
      });
    }
  });

  it("SEV1 escalates to pagerduty first", () => {
    const contacts = getEscalationMatrix("SEV1");
    expect(contacts[0].channel).toBe("pagerduty");
  });

  it("SEV1 includes CTO escalation", () => {
    const contacts = getEscalationMatrix("SEV1");
    const hasCto = contacts.some((c) => c.role === "cto");
    expect(hasCto).toBe(true);
  });

  it("SEV1 first contact has shortest SLA", () => {
    const contacts = getEscalationMatrix("SEV1");
    const minSla = Math.min(...contacts.map((c) => c.slaMinutes));
    expect(contacts[0].slaMinutes).toBe(minSla);
  });

  it("SEV3 does not include CTO (low severity)", () => {
    const contacts = getEscalationMatrix("SEV3");
    const hasCto = contacts.some((c) => c.role === "cto");
    expect(hasCto).toBe(false);
  });

  it("all contacts have required fields", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      for (const contact of getEscalationMatrix(sev)) {
        expect(contact.role).toBeTruthy();
        expect(contact.channel).toBeTruthy();
        expect(contact.target).toBeTruthy();
        expect(contact.slaMinutes).toBeGreaterThan(0);
      }
    }
  });

  it("SEV1 has more escalation contacts than SEV3", () => {
    expect(getEscalationMatrix("SEV1").length).toBeGreaterThan(getEscalationMatrix("SEV3").length);
  });
});
