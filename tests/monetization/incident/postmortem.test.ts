import { describe, expect, it } from "vitest";
import { generatePostMortemTemplate, type IncidentSummary } from "../../../src/monetization/incident/postmortem.js";

const incident: IncidentSummary = {
  incidentId: "INC-001",
  severity: "SEV1",
  title: "Stripe API outage",
  startedAt: new Date("2026-02-24T10:00:00Z"),
  detectedAt: new Date("2026-02-24T10:05:00Z"),
  resolvedAt: new Date("2026-02-24T11:00:00Z"),
  affectedSystems: ["stripe-api", "credit-ledger"],
  affectedTenantCount: 42,
  revenueImpactCents: 50000,
};

describe("generatePostMortemTemplate", () => {
  it("returns a report with all required sections", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.sections.summary).toBeTruthy();
    expect(report.sections.timeline).toBeTruthy();
    expect(report.sections.rootCause).toBeTruthy();
    expect(report.sections.impact).toBeTruthy();
    expect(report.sections.detection).toBeTruthy();
    expect(report.sections.resolution).toBeTruthy();
    expect(report.sections.actionItems).toBeTruthy();
    expect(report.sections.lessonsLearned).toBeTruthy();
  });

  it("report title matches incident title", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.title).toBe(incident.title);
  });

  it("report severity matches incident severity", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.severity).toBe("SEV1");
  });

  it("markdown includes incident ID", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.markdown).toContain("INC-001");
  });

  it("summary includes affected tenant count", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.sections.summary).toContain("42");
  });

  it("summary includes revenue impact", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.sections.summary).toContain("500.00");
  });

  it("handles ongoing incident (no resolvedAt)", () => {
    const ongoing: IncidentSummary = { ...incident, resolvedAt: null };
    const report = generatePostMortemTemplate(ongoing);
    expect(report.markdown).toContain("ONGOING");
  });

  it("handles null revenue impact", () => {
    const noRevenue: IncidentSummary = { ...incident, revenueImpactCents: null };
    const report = generatePostMortemTemplate(noRevenue);
    expect(report.sections.summary).toContain("TBD");
  });

  it("timeline includes start and detection times", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.sections.timeline).toContain("2026-02-24T10:00:00.000Z");
    expect(report.sections.timeline).toContain("2026-02-24T10:05:00.000Z");
  });
});
