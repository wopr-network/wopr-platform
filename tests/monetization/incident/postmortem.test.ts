import { describe, expect, it } from "vitest";
import { generatePostMortemTemplate, type IncidentSummary } from "@wopr-network/platform-core/monetization/incident/postmortem";

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
    // summary contains incident details
    expect(report.sections.summary).toContain("INC-001");
    expect(report.sections.summary).toContain("SEV1");
    // timeline contains timestamps
    expect(report.sections.timeline).toContain("2026-02-24T10:00:00.000Z");
    // rootCause is a template string (contains TODO placeholder)
    expect(report.sections.rootCause).toContain("root cause");
    // impact contains tenant count
    expect(report.sections.impact).toContain("42");
    // detection contains TTD
    expect(report.sections.detection).toContain("Time to detect");
    // resolution contains TTR
    expect(report.sections.resolution).toContain("Time to resolve");
    // actionItems is a table
    expect(report.sections.actionItems).toContain("Action");
    // lessonsLearned has structure
    expect(report.sections.lessonsLearned).toContain("What went well");
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

  it("action items derive due dates from resolvedAt (SEV1 = 7 days)", () => {
    // resolvedAt: 2026-02-24T11:00:00Z + 7 days = 2026-03-03
    const report = generatePostMortemTemplate(incident);
    expect(report.sections.actionItems).toContain("2026-03-03");
    expect(report.sections.actionItems).not.toContain("TBD");
  });

  it("action items derive due dates from startedAt for ongoing incidents", () => {
    const ongoing: IncidentSummary = { ...incident, resolvedAt: null };
    // startedAt: 2026-02-24T10:00:00Z + 7 days = 2026-03-03
    const report = generatePostMortemTemplate(ongoing);
    expect(report.sections.actionItems).toContain("2026-03-03");
    expect(report.sections.actionItems).not.toContain("TBD");
  });

  it("timeline includes start and detection times", () => {
    const report = generatePostMortemTemplate(incident);
    expect(report.sections.timeline).toContain("2026-02-24T10:00:00.000Z");
    expect(report.sections.timeline).toContain("2026-02-24T10:05:00.000Z");
  });
});
