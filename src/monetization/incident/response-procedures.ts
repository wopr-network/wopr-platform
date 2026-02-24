import type { Severity } from "./severity.js";

export interface ResponseStep {
  order: number;
  action: string;
  owner: string; // role, not person
  slaMinutes: number | null;
}

export interface ResponseProcedure {
  severity: Severity;
  summary: string;
  slaAcknowledgeMinutes: number;
  slaResolveMinutes: number;
  steps: ResponseStep[];
}

const SEV1_PROCEDURE: ResponseProcedure = {
  severity: "SEV1",
  summary: "Total payment outage — no revenue flowing. Immediate all-hands response required.",
  slaAcknowledgeMinutes: 5,
  slaResolveMinutes: 60,
  steps: [
    {
      order: 1,
      action: "Page on-call engineer and engineering lead immediately",
      owner: "on-call-engineer",
      slaMinutes: 5,
    },
    {
      order: 2,
      action: "Run payment health probe: `npx tsx src/monetization/incident/health-probe.ts`",
      owner: "on-call-engineer",
      slaMinutes: 10,
    },
    {
      order: 3,
      action: "Check Stripe status page (https://status.stripe.com) for upstream outages",
      owner: "on-call-engineer",
      slaMinutes: 10,
    },
    {
      order: 4,
      action: "Post internal incident notification to #billing-incidents channel",
      owner: "incident-commander",
      slaMinutes: 15,
    },
    {
      order: 5,
      action: "Send SEV1 customer communication if impact confirmed",
      owner: "incident-commander",
      slaMinutes: 20,
    },
    {
      order: 6,
      action: "Verify webhook endpoint connectivity and Stripe webhook secret rotation status",
      owner: "on-call-engineer",
      slaMinutes: 20,
    },
    {
      order: 7,
      action: "Check DLQ depth and gateway error rates in admin health dashboard",
      owner: "on-call-engineer",
      slaMinutes: 25,
    },
    {
      order: 8,
      action: "Escalate to CTO if not resolved within 30 minutes",
      owner: "engineering-lead",
      slaMinutes: 30,
    },
    {
      order: 9,
      action: "Restore payment processing and verify with test transaction",
      owner: "on-call-engineer",
      slaMinutes: 60,
    },
    {
      order: 10,
      action: "Confirm all DLQ events are replayed and metrics return to normal",
      owner: "on-call-engineer",
      slaMinutes: null,
    },
  ],
};

const SEV2_PROCEDURE: ResponseProcedure = {
  severity: "SEV2",
  summary: "Degraded payment processing — partial failures affecting subset of transactions.",
  slaAcknowledgeMinutes: 15,
  slaResolveMinutes: 240,
  steps: [
    {
      order: 1,
      action: "Alert on-call engineer via Slack #billing-incidents",
      owner: "on-call-engineer",
      slaMinutes: 15,
    },
    {
      order: 2,
      action: "Run payment health probe to identify degraded components",
      owner: "on-call-engineer",
      slaMinutes: 20,
    },
    {
      order: 3,
      action: "Check DLQ depth — if > 50, begin manual replay of queued events",
      owner: "on-call-engineer",
      slaMinutes: 30,
    },
    {
      order: 4,
      action: "Identify affected tenants from credit deduction failure logs",
      owner: "on-call-engineer",
      slaMinutes: 45,
    },
    {
      order: 5,
      action: "Send SEV2 internal notification if degradation persists > 30 minutes",
      owner: "incident-commander",
      slaMinutes: 45,
    },
    {
      order: 6,
      action: "Investigate auto-topup failure root cause (Stripe card errors vs system errors)",
      owner: "on-call-engineer",
      slaMinutes: 60,
    },
    {
      order: 7,
      action: "Resolve root cause and verify metrics normalize",
      owner: "on-call-engineer",
      slaMinutes: 240,
    },
  ],
};

const SEV3_PROCEDURE: ResponseProcedure = {
  severity: "SEV3",
  summary: "Early warning signals — investigate proactively to prevent escalation.",
  slaAcknowledgeMinutes: 60,
  slaResolveMinutes: 1440,
  steps: [
    {
      order: 1,
      action: "Review payment health dashboard and alert statuses",
      owner: "on-call-engineer",
      slaMinutes: 60,
    },
    {
      order: 2,
      action: "Check DLQ for new failed meter events and identify patterns",
      owner: "on-call-engineer",
      slaMinutes: 120,
    },
    {
      order: 3,
      action: "Monitor gateway error rate trend over next 30 minutes",
      owner: "on-call-engineer",
      slaMinutes: 90,
    },
    {
      order: 4,
      action: "Review tenants with negative balance and trigger manual credit reconciliation if needed",
      owner: "on-call-engineer",
      slaMinutes: 240,
    },
    {
      order: 5,
      action: "Create tracking ticket if warning persists beyond 2 hours",
      owner: "on-call-engineer",
      slaMinutes: 1440,
    },
  ],
};

export function getResponseProcedure(severity: Severity): ResponseProcedure {
  switch (severity) {
    case "SEV1":
      return SEV1_PROCEDURE;
    case "SEV2":
      return SEV2_PROCEDURE;
    case "SEV3":
      return SEV3_PROCEDURE;
  }
}
