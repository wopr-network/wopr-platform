import { describe, expect, it } from "vitest";
import { generatePostMortemTemplate, type IncidentSummary } from "./postmortem.js";

function makeIncident(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    incidentId: "INC-042",
    severity: "SEV1",
    title: "Total payment outage",
    startedAt: new Date("2026-01-15T12:00:00Z"),
    detectedAt: new Date("2026-01-15T12:05:00Z"),
    resolvedAt: new Date("2026-01-15T13:00:00Z"),
    affectedSystems: ["stripe-gateway"],
    affectedTenantCount: 150,
    revenueImpactCents: 50000,
    ...overrides,
  };
}

describe("generatePostMortemTemplate", () => {
  it("returns title and severity from incident", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.title).toBe("Total payment outage");
    expect(report.severity).toBe("SEV1");
  });

  it("summary section includes incident ID, severity, duration", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.sections.summary).toContain("INC-042");
    expect(report.sections.summary).toContain("SEV1");
    expect(report.sections.summary).toContain("1h");
  });

  it("summary section includes revenue impact formatted as dollars", () => {
    const report = generatePostMortemTemplate(makeIncident({ revenueImpactCents: 12345 }));
    expect(report.sections.summary).toContain("$123.45");
  });

  it("summary shows TBD when revenueImpactCents is null", () => {
    const report = generatePostMortemTemplate(makeIncident({ revenueImpactCents: null }));
    expect(report.sections.summary).toContain("TBD");
  });

  it("duration shows ONGOING when resolvedAt is null", () => {
    const report = generatePostMortemTemplate(makeIncident({ resolvedAt: null }));
    expect(report.sections.summary).toContain("ONGOING");
    expect(report.markdown).toContain("ONGOING");
  });

  it("timeline includes start, detect, resolve times", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.sections.timeline).toContain("2026-01-15T12:00:00.000Z");
    expect(report.sections.timeline).toContain("2026-01-15T12:05:00.000Z");
    expect(report.sections.timeline).toContain("2026-01-15T13:00:00.000Z");
  });

  it("timeline shows TTD (time to detect)", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.sections.timeline).toContain("TTD: 5m");
  });

  it("detection section includes TTD", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.sections.detection).toContain("5m");
  });

  it("markdown contains all section headers", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.markdown).toContain("## Summary");
    expect(report.markdown).toContain("## Timeline");
    expect(report.markdown).toContain("## Root Cause");
    expect(report.markdown).toContain("## Impact");
    expect(report.markdown).toContain("## Detection");
    expect(report.markdown).toContain("## Resolution");
    expect(report.markdown).toContain("## Action Items");
    expect(report.markdown).toContain("## Lessons Learned");
  });

  it("markdown header includes title and status", () => {
    const report = generatePostMortemTemplate(makeIncident());
    expect(report.markdown).toContain("# Post-Mortem: Total payment outage");
    expect(report.markdown).toContain("**Status:** RESOLVED");
  });

  it("markdown shows ONGOING status when not resolved", () => {
    const report = generatePostMortemTemplate(makeIncident({ resolvedAt: null }));
    expect(report.markdown).toContain("**Status:** ONGOING");
  });

  it("shows 'unknown' when affectedSystems is empty", () => {
    const report = generatePostMortemTemplate(makeIncident({ affectedSystems: [] }));
    expect(report.sections.summary).toContain("unknown");
  });

  it("formats duration with hours and minutes", () => {
    const report = generatePostMortemTemplate(
      makeIncident({
        startedAt: new Date("2026-01-15T12:00:00Z"),
        resolvedAt: new Date("2026-01-15T13:30:00Z"),
      }),
    );
    expect(report.sections.summary).toContain("1h 30m");
  });

  it("formats duration with only minutes when under 1h", () => {
    const report = generatePostMortemTemplate(
      makeIncident({
        startedAt: new Date("2026-01-15T12:00:00Z"),
        resolvedAt: new Date("2026-01-15T12:45:00Z"),
      }),
    );
    expect(report.sections.summary).toContain("45m");
  });
});
