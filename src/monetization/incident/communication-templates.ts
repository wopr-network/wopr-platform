import type { Severity } from "./severity.js";

export interface IncidentContext {
  incidentId: string;
  startedAt: Date;
  affectedSystems: string[];
  customerImpact: string;
  currentStatus: string;
}

export interface IncidentCommunication {
  audience: "customer" | "internal";
  subject: string;
  body: string;
}

export function getCustomerTemplate(severity: Severity, context: IncidentContext): IncidentCommunication {
  const startedAtStr = context.startedAt.toISOString();

  switch (severity) {
    case "SEV1":
      return {
        audience: "customer",
        subject: `[Action Required] Payment processing outage — ${context.incidentId}`,
        body: `We are currently experiencing a payment processing outage that began at ${startedAtStr}.

Impact: ${context.customerImpact}

Our engineering team is actively investigating and working to restore service. We will provide updates every 30 minutes.

Current status: ${context.currentStatus}

We apologize for the disruption. No action is required on your part at this time.`,
      };

    case "SEV2":
      return {
        audience: "customer",
        subject: `[Notice] Degraded payment processing — ${context.incidentId}`,
        body: `We are experiencing degraded payment processing that began at ${startedAtStr}.

Impact: ${context.customerImpact}

Some transactions may be delayed or require retry. Our team is actively investigating.

Current status: ${context.currentStatus}

We will notify you once the issue is resolved.`,
      };

    case "SEV3":
      return {
        audience: "customer",
        subject: `[Notice] Payment system warning — ${context.incidentId}`,
        body: `We have detected early warning signals in our payment system as of ${startedAtStr}.

Impact: ${context.customerImpact}

Our team is monitoring the situation proactively. No disruption to your service is expected at this time.

Current status: ${context.currentStatus}`,
      };
  }
}

export function getInternalTemplate(severity: Severity, context: IncidentContext): IncidentCommunication {
  const startedAtStr = context.startedAt.toISOString();
  const systems = context.affectedSystems.join(", ") || "unknown";

  switch (severity) {
    case "SEV1":
      return {
        audience: "internal",
        subject: `🚨 SEV1 INCIDENT: Payment outage — ${context.incidentId}`,
        body: `**SEVERITY 1 — TOTAL PAYMENT OUTAGE**

Incident ID: ${context.incidentId}
Started at: ${startedAtStr}
Affected systems: ${systems}

Customer impact: ${context.customerImpact}
Current status: ${context.currentStatus}

**IMMEDIATE ACTIONS REQUIRED:**
1. Page on-call engineer NOW
2. Join #billing-incidents Slack channel
3. Run payment health probe: \`npx tsx src/monetization/incident/health-probe.ts\`
4. Check Stripe status: https://status.stripe.com
5. Escalate to CTO if not resolved in 30 minutes

ACK SLA: 5 minutes | RESOLVE SLA: 60 minutes`,
      };

    case "SEV2":
      return {
        audience: "internal",
        subject: `⚠️ SEV2 INCIDENT: Degraded payments — ${context.incidentId}`,
        body: `**SEVERITY 2 — DEGRADED PAYMENT PROCESSING**

Incident ID: ${context.incidentId}
Started at: ${startedAtStr}
Affected systems: ${systems}

Customer impact: ${context.customerImpact}
Current status: ${context.currentStatus}

**ACTIONS REQUIRED:**
1. Alert on-call engineer via #billing-incidents
2. Run payment health probe to identify degraded components
3. Check DLQ depth and begin replay if > 50 events
4. Identify affected tenants from credit deduction failure logs

ACK SLA: 15 minutes | RESOLVE SLA: 4 hours`,
      };

    case "SEV3":
      return {
        audience: "internal",
        subject: `ℹ️ SEV3 WARNING: Payment system signals — ${context.incidentId}`,
        body: `**SEVERITY 3 — PAYMENT SYSTEM WARNING**

Incident ID: ${context.incidentId}
Started at: ${startedAtStr}
Affected systems: ${systems}

Customer impact: ${context.customerImpact}
Current status: ${context.currentStatus}

**ACTIONS:**
1. Review payment health dashboard
2. Monitor DLQ and gateway error rate trends
3. Create tracking ticket if warning persists beyond 2 hours

ACK SLA: 60 minutes | RESOLVE SLA: 24 hours`,
      };
  }
}
