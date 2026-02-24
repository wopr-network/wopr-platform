import type { Severity } from "./severity.js";

export interface IncidentSummary {
  incidentId: string;
  severity: Severity;
  title: string;
  startedAt: Date;
  detectedAt: Date;
  resolvedAt: Date | null;
  affectedSystems: string[];
  affectedTenantCount: number;
  revenueImpactCents: number | null;
}

export interface PostMortemReport {
  title: string;
  severity: Severity;
  sections: {
    summary: string;
    timeline: string;
    rootCause: string;
    impact: string;
    detection: string;
    resolution: string;
    actionItems: string;
    lessonsLearned: string;
  };
  markdown: string;
}

export function generatePostMortemTemplate(incident: IncidentSummary): PostMortemReport {
  const durationMs = incident.resolvedAt ? incident.resolvedAt.getTime() - incident.startedAt.getTime() : null;
  const durationStr = durationMs !== null ? formatDuration(durationMs) : "ONGOING";
  const ttdMs = incident.detectedAt.getTime() - incident.startedAt.getTime();
  const revenueImpact =
    incident.revenueImpactCents !== null ? `$${(incident.revenueImpactCents / 100).toFixed(2)}` : "TBD";
  const systems = incident.affectedSystems.join(", ") || "unknown";

  const sections = {
    summary: `**Incident:** ${incident.incidentId} — ${incident.title}
**Severity:** ${incident.severity}
**Duration:** ${durationStr}
**Affected systems:** ${systems}
**Affected tenants:** ${incident.affectedTenantCount}
**Revenue impact:** ${revenueImpact}`,

    timeline: `| Time | Event |
|------|-------|
| ${incident.startedAt.toISOString()} | Incident started |
| ${incident.detectedAt.toISOString()} | Incident detected (TTD: ${formatDuration(ttdMs)}) |
| ${incident.resolvedAt?.toISOString() ?? "ONGOING"} | Incident resolved |
| _Add more events_ | _Add description_ |`,

    rootCause: `_[TODO: Describe the root cause. What technical failure triggered this incident?]_

Contributing factors:
- _[TODO: List contributing factors]_`,

    impact: `- **Customer impact:** ${incident.affectedTenantCount} tenants affected
- **Revenue impact:** ${revenueImpact}
- **Systems affected:** ${systems}
- **Duration of impact:** ${durationStr}

_[TODO: Add specific impact details — which features were unavailable, error rates observed, etc.]_`,

    detection: `- **Time to detect (TTD):** ${formatDuration(ttdMs)}
- **Detection method:** _[TODO: How was this detected? Alert, customer report, health probe, etc.]_
- **Alert that fired:** _[TODO: Which alert(s) fired first?]_

_[TODO: Describe how the incident was detected and whether detection was timely.]_`,

    resolution: `- **Time to resolve (TTR):** ${durationStr}
- **Resolved by:** _[TODO: Who resolved it?]_
- **Resolution steps:**
  1. _[TODO: List the steps taken to resolve the incident]_

_[TODO: Describe what fixed the issue and how service was restored.]_`,

    actionItems: `| Action | Owner | Due Date | Priority |
|--------|-------|----------|----------|
| _[TODO: Add action item]_ | _[TODO: Owner]_ | _[TODO: Date]_ | P1 |
| Improve detection alert thresholds | on-call-engineer | TBD | P2 |
| Add runbook link to alert notification | on-call-engineer | TBD | P2 |`,

    lessonsLearned: `**What went well:**
- _[TODO: What worked well in detection and response?]_

**What could be improved:**
- _[TODO: What could we do better next time?]_

**Process improvements:**
- _[TODO: List process improvements to prevent recurrence]_`,
  };

  const markdown = `# Post-Mortem: ${incident.title}

**Incident ID:** ${incident.incidentId}
**Severity:** ${incident.severity}
**Date:** ${incident.startedAt.toISOString().split("T")[0]}
**Status:** ${incident.resolvedAt ? "RESOLVED" : "ONGOING"}

---

## Summary

${sections.summary}

---

## Timeline

${sections.timeline}

---

## Root Cause

${sections.rootCause}

---

## Impact

${sections.impact}

---

## Detection

${sections.detection}

---

## Resolution

${sections.resolution}

---

## Action Items

${sections.actionItems}

---

## Lessons Learned

${sections.lessonsLearned}
`;

  return {
    title: incident.title,
    severity: incident.severity,
    sections,
    markdown,
  };
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}
