import type { Severity } from "./severity.js";

export interface EscalationContact {
  role: string;
  channel: string; // "slack" | "pagerduty" | "email" | "phone"
  target: string; // placeholder like "#billing-incidents" or "on-call-eng"
  slaMinutes: number;
  order: number;
}

const SEV1_ESCALATION: EscalationContact[] = [
  {
    order: 1,
    role: "on-call-engineer",
    channel: "pagerduty",
    target: "on-call-eng",
    slaMinutes: 5,
  },
  {
    order: 2,
    role: "engineering-lead",
    channel: "slack",
    target: "#billing-incidents",
    slaMinutes: 10,
  },
  {
    order: 3,
    role: "incident-commander",
    channel: "slack",
    target: "#billing-incidents",
    slaMinutes: 15,
  },
  {
    order: 4,
    role: "cto",
    channel: "phone",
    target: "cto-oncall",
    slaMinutes: 30,
  },
];

const SEV2_ESCALATION: EscalationContact[] = [
  {
    order: 1,
    role: "on-call-engineer",
    channel: "slack",
    target: "#billing-incidents",
    slaMinutes: 15,
  },
  {
    order: 2,
    role: "engineering-lead",
    channel: "slack",
    target: "#billing-incidents",
    slaMinutes: 60,
  },
  {
    order: 3,
    role: "cto",
    channel: "email",
    target: "cto@wopr.network",
    slaMinutes: 240,
  },
];

const SEV3_ESCALATION: EscalationContact[] = [
  {
    order: 1,
    role: "on-call-engineer",
    channel: "slack",
    target: "#billing-incidents",
    slaMinutes: 60,
  },
  {
    order: 2,
    role: "engineering-lead",
    channel: "slack",
    target: "#billing-incidents",
    slaMinutes: 240,
  },
];

export function getEscalationMatrix(severity: Severity): EscalationContact[] {
  switch (severity) {
    case "SEV1":
      return SEV1_ESCALATION;
    case "SEV2":
      return SEV2_ESCALATION;
    case "SEV3":
      return SEV3_ESCALATION;
  }
}
