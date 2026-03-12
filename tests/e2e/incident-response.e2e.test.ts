import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChecker, buildAlerts } from "@wopr-network/platform-core/observability/alerts";
import { buildCriticalAlerts } from "@wopr-network/platform-core/observability/critical-alerts";
import { DrizzleMetricsRepository } from "@wopr-network/platform-core/observability/drizzle-metrics-repository";
import { MetricsCollector } from "@wopr-network/platform-core/observability/metrics";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import {
  classifySeverity,
  getEscalationMatrix,
  getResponseProcedure,
  generatePostMortemTemplate,
  getCustomerTemplate,
  getInternalTemplate,
} from "@wopr-network/platform-core/monetization/incident/index";
import type { IncidentSummary } from "@wopr-network/platform-core/monetization/incident/index";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pool: PGlite;
let db: DrizzleDb;
let metrics: MetricsCollector;
let repo: DrizzleMetricsRepository;

// In-memory fleet event repo stub
const fleetStopFired = { value: false };
const fakeFleetEventRepo = {
  isFleetStopFired: async () => fleetStopFired.value,
  clearFleetStop: async () => {
    fleetStopFired.value = false;
  },
};

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

// ---------------------------------------------------------------------------
// E2E: Incident creation — classify severity from observable signals
// ---------------------------------------------------------------------------

describe("E2E: incident response — creation, escalation, assignment, resolution, post-mortem", () => {
  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    fleetStopFired.value = false;
    repo = new DrizzleMetricsRepository(db);
    metrics = new MetricsCollector(repo);
  });

  // =========================================================================
  // STEP 1: Incident creation — classify severity from signals
  // =========================================================================

  it("1. classify SEV1 when Stripe is unreachable", () => {
    const result = classifySeverity({
      stripeReachable: false,
      webhooksReceiving: true,
      gatewayErrorRate: 0.02,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV1");
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("Stripe API unreachable");
  });

  it("1b. classify SEV1 when gateway error rate exceeds 50%", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: true,
      gatewayErrorRate: 0.75,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV1");
    expect(result.reasons.some((r) => r.includes("75.0%"))).toBe(true);
  });

  it("1c. classify SEV1 when webhooks stopped receiving", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: false,
      gatewayErrorRate: 0.01,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV1");
    expect(result.reasons[0]).toContain("webhook");
  });

  it("1d. classify SEV1 when 3+ alerts firing", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: true,
      gatewayErrorRate: 0.02,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 3,
    });

    expect(result.severity).toBe("SEV1");
    expect(result.reasons.some((r) => r.includes("3 alerts"))).toBe(true);
  });

  // =========================================================================
  // STEP 2: Escalation — verify escalation matrix for each severity
  // =========================================================================

  it("2. SEV1 escalation matrix has CTO phone call within 30 minutes", () => {
    const matrix = getEscalationMatrix("SEV1");

    expect(matrix.length).toBeGreaterThanOrEqual(4);
    expect(matrix[0].channel).toBe("pagerduty");
    expect(matrix[0].slaMinutes).toBe(5);

    const ctoContact = matrix.find((c) => c.role === "cto");
    expect(ctoContact).toBeDefined();
    expect(ctoContact!.channel).toBe("phone");
    expect(ctoContact!.slaMinutes).toBeLessThanOrEqual(30);
  });

  it("2b. SEV2 escalation matrix — slack-first, no immediate phone escalation", () => {
    const matrix = getEscalationMatrix("SEV2");

    expect(matrix[0].channel).toBe("slack");
    expect(matrix[0].slaMinutes).toBe(15);

    const phoneContacts = matrix.filter((c) => c.channel === "phone");
    expect(phoneContacts).toHaveLength(0);

    const ctoContact = matrix.find((c) => c.role === "cto");
    expect(ctoContact).toBeDefined();
    expect(ctoContact!.channel).toBe("email");
  });

  it("2c. SEV3 escalation matrix — minimal, engineer-only", () => {
    const matrix = getEscalationMatrix("SEV3");

    expect(matrix).toHaveLength(2);
    expect(matrix[0].role).toBe("on-call-engineer");
    expect(matrix[0].slaMinutes).toBe(60);

    const ctoContacts = matrix.filter((c) => c.role === "cto");
    expect(ctoContacts).toHaveLength(0);
  });

  // =========================================================================
  // STEP 3: Assignment — response procedure includes ordered steps with owners
  // =========================================================================

  it("3. SEV1 response procedure has 10 steps with SLAs and owners", () => {
    const procedure = getResponseProcedure("SEV1");

    expect(procedure.severity).toBe("SEV1");
    expect(procedure.slaAcknowledgeMinutes).toBe(5);
    expect(procedure.slaResolveMinutes).toBe(60);
    expect(procedure.steps.length).toBeGreaterThanOrEqual(10);

    // Verify ordering
    for (let i = 1; i < procedure.steps.length; i++) {
      expect(procedure.steps[i].order).toBeGreaterThan(procedure.steps[i - 1].order);
    }

    // Verify each step has required fields
    for (const step of procedure.steps) {
      expect(step.owner).toBeTruthy();
      expect(step.action).toBeTruthy();
    }

    // Health probe step
    const probeStep = procedure.steps.find((s) => s.action.includes("health probe"));
    expect(probeStep).toBeDefined();

    // CTO escalation within 30 minutes
    const ctoStep = procedure.steps.find((s) => s.action.toLowerCase().includes("cto"));
    expect(ctoStep).toBeDefined();
    expect(ctoStep!.slaMinutes).toBeLessThanOrEqual(30);
  });

  it("3b. SEV2 procedure has 4-hour resolve SLA", () => {
    const procedure = getResponseProcedure("SEV2");

    expect(procedure.severity).toBe("SEV2");
    expect(procedure.slaAcknowledgeMinutes).toBe(15);
    expect(procedure.slaResolveMinutes).toBe(240);
    expect(procedure.steps.length).toBeGreaterThanOrEqual(5);
  });

  it("3c. SEV3 procedure has 24-hour resolve SLA", () => {
    const procedure = getResponseProcedure("SEV3");

    expect(procedure.severity).toBe("SEV3");
    expect(procedure.slaAcknowledgeMinutes).toBe(60);
    expect(procedure.slaResolveMinutes).toBe(1440);
  });

  // =========================================================================
  // STEP 4: Alert checker detects and fires alerts based on live metrics
  // =========================================================================

  it("4. alert checker fires gateway-error-rate when error rate exceeds 5%", async () => {
    const alerts = buildAlerts(metrics, fakeFleetEventRepo);
    const fired: string[] = [];
    const checker = new AlertChecker(alerts, {
      onFire: (name) => fired.push(name),
      fleetEventRepo: fakeFleetEventRepo,
    });

    // Record enough gateway errors to exceed 5%
    for (let i = 0; i < 10; i++) {
      await repo.recordGatewayRequest("llm");
    }
    for (let i = 0; i < 2; i++) {
      await repo.recordGatewayError("llm");
    }

    const results = await checker.checkAll();
    const gatewayResult = results.find((r) => r.name === "gateway-error-rate");
    expect(gatewayResult).toBeDefined();
    expect(gatewayResult!.firing).toBe(true);
    expect(fired).toContain("gateway-error-rate");
  });

  it("4b. alert checker fires credit-deduction-spike when failures > 10", async () => {
    const alerts = buildAlerts(metrics, fakeFleetEventRepo);
    const fired: string[] = [];
    const checker = new AlertChecker(alerts, {
      onFire: (name) => fired.push(name),
      fleetEventRepo: fakeFleetEventRepo,
    });

    for (let i = 0; i < 11; i++) {
      await repo.recordCreditDeductionFailure();
    }

    const results = await checker.checkAll();
    const creditResult = results.find((r) => r.name === "credit-deduction-spike");
    expect(creditResult).toBeDefined();
    expect(creditResult!.firing).toBe(true);
    expect(fired).toContain("credit-deduction-spike");
  });

  it("4c. alert checker fires fleet-unexpected-stop when fleet stop event fires", async () => {
    const alerts = buildAlerts(metrics, fakeFleetEventRepo);
    const fired: string[] = [];
    const checker = new AlertChecker(alerts, {
      onFire: (name) => fired.push(name),
      fleetEventRepo: fakeFleetEventRepo,
    });

    fleetStopFired.value = true;

    const results = await checker.checkAll();
    const fleetResult = results.find((r) => r.name === "fleet-unexpected-stop");
    expect(fleetResult).toBeDefined();
    expect(fleetResult!.firing).toBe(true);
    expect(fired).toContain("fleet-unexpected-stop");

    // Fleet stop should be cleared after check
    expect(fleetStopFired.value).toBe(false);
  });

  it("4d. alert checker deduplicates — onFire only called once per state transition", async () => {
    const alerts = buildAlerts(metrics, fakeFleetEventRepo);
    let fireCount = 0;
    let resolveCount = 0;
    const checker = new AlertChecker(alerts, {
      onFire: () => fireCount++,
      onResolve: () => resolveCount++,
      fleetEventRepo: fakeFleetEventRepo,
    });

    // Trigger credit spike
    for (let i = 0; i < 11; i++) {
      await repo.recordCreditDeductionFailure();
    }
    await checker.checkAll(); // transition: not-firing -> firing (onFire called)
    await checker.checkAll(); // stays firing (onFire NOT called again)

    expect(fireCount).toBe(1);
    expect(resolveCount).toBe(0);
  });

  // =========================================================================
  // STEP 5: Critical alerts (SEV1) — db/auth/gateway health checks
  // =========================================================================

  it("5. critical alerts fire when database is unavailable", async () => {
    const critAlerts = buildCriticalAlerts({
      metrics,
      dbHealthCheck: () => false,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });

    const checker = new AlertChecker(critAlerts);
    const results = await checker.checkAll();

    const dbAlert = results.find((r) => r.name === "sev1-database-unavailable");
    expect(dbAlert).toBeDefined();
    expect(dbAlert!.firing).toBe(true);
    expect(dbAlert!.message).toContain("CRITICAL");

    const authAlert = results.find((r) => r.name === "sev1-auth-failure");
    expect(authAlert).toBeDefined();
    expect(authAlert!.firing).toBe(false);
  });

  it("5b. critical alerts fire when auth service is down", async () => {
    const critAlerts = buildCriticalAlerts({
      metrics,
      dbHealthCheck: () => true,
      authHealthCheck: () => false,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });

    const checker = new AlertChecker(critAlerts);
    const results = await checker.checkAll();

    const authAlert = results.find((r) => r.name === "sev1-auth-failure");
    expect(authAlert).toBeDefined();
    expect(authAlert!.firing).toBe(true);
    expect(authAlert!.message).toContain("CRITICAL");
  });

  it("5c. critical alerts fire when inference gateway is down", async () => {
    const critAlerts = buildCriticalAlerts({
      metrics,
      dbHealthCheck: () => true,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: false, latencyMs: 30000 }),
    });

    const checker = new AlertChecker(critAlerts);
    const results = await checker.checkAll();

    const gatewayAlert = results.find((r) => r.name === "sev1-inference-gateway-down");
    expect(gatewayAlert).toBeDefined();
    expect(gatewayAlert!.firing).toBe(true);
    expect(gatewayAlert!.message).toContain("CRITICAL");
  });

  // =========================================================================
  // STEP 6: Resolution — alerts resolve after metrics normalize
  // =========================================================================

  it("6. alert resolves after metrics return to normal (onResolve fires)", async () => {
    // Use a separate fresh db for this test to control metric window precisely
    const { db: freshDb, pool: freshPool } = await createTestDb();
    const baseNow = Date.now();
    try {
      const freshRepo = new DrizzleMetricsRepository(freshDb);
      const freshMetrics = new MetricsCollector(freshRepo);
      const freshAlerts = buildAlerts(freshMetrics, fakeFleetEventRepo);
      const resolved: string[] = [];
      const fired: string[] = [];
      const checker = new AlertChecker(freshAlerts, {
        onFire: (name) => fired.push(name),
        onResolve: (name) => resolved.push(name),
        fleetEventRepo: fakeFleetEventRepo,
      });

      // Spike credit failures -> alert fires
      vi.useFakeTimers();
      vi.setSystemTime(baseNow);
      for (let i = 0; i < 11; i++) {
        await freshRepo.recordCreditDeductionFailure();
      }
      await checker.checkAll();
      expect(fired).toContain("credit-deduction-spike");

      // Advance time past the 5-minute window so failures are no longer counted
      vi.setSystemTime(baseNow + 6 * 60_000);
      const results = await checker.checkAll();
      const creditResult = results.find((r) => r.name === "credit-deduction-spike");
      expect(creditResult).toBeDefined();
      expect(creditResult!.firing).toBe(false);
      expect(resolved).toContain("credit-deduction-spike");
    } finally {
      vi.useRealTimers();
      await freshPool.close();
    }
  });

  // =========================================================================
  // STEP 7: Post-mortem — generate report for a resolved SEV1 incident
  // =========================================================================

  it("7. post-mortem report generated for resolved SEV1 incident", () => {
    const incident: IncidentSummary = {
      incidentId: "INC-2025-001",
      severity: "SEV1",
      title: "Payment processing outage — Stripe API unreachable",
      startedAt: new Date("2025-06-01T14:00:00Z"),
      detectedAt: new Date("2025-06-01T14:03:00Z"),
      resolvedAt: new Date("2025-06-01T15:10:00Z"),
      affectedSystems: ["stripe-api", "credit-deduction", "gateway"],
      affectedTenantCount: 342,
      revenueImpactCents: 45000,
    };

    const report = generatePostMortemTemplate(incident);

    expect(report.title).toBe(incident.title);
    expect(report.severity).toBe("SEV1");

    // Sections all present
    expect(report.sections.summary).toContain("INC-2025-001");
    expect(report.sections.summary).toContain("SEV1");
    expect(report.sections.summary).toContain("342");
    expect(report.sections.summary).toContain("$450.00");

    expect(report.sections.timeline).toContain("2025-06-01T14:00:00.000Z");
    expect(report.sections.timeline).toContain("2025-06-01T14:03:00.000Z");
    expect(report.sections.timeline).toContain("TTD:");

    expect(report.sections.impact).toContain("342 tenants");
    expect(report.sections.impact).toContain("$450.00");

    expect(report.sections.detection).toContain("3m");
    expect(report.sections.resolution).toContain("1h 10m");

    // Markdown contains all major sections
    expect(report.markdown).toContain("# Post-Mortem:");
    expect(report.markdown).toContain("## Summary");
    expect(report.markdown).toContain("## Timeline");
    expect(report.markdown).toContain("## Root Cause");
    expect(report.markdown).toContain("## Impact");
    expect(report.markdown).toContain("## Detection");
    expect(report.markdown).toContain("## Resolution");
    expect(report.markdown).toContain("## Action Items");
    expect(report.markdown).toContain("## Lessons Learned");
    expect(report.markdown).toContain("RESOLVED");
  });

  it("7b. post-mortem for ongoing SEV2 incident (no resolvedAt)", () => {
    const incident: IncidentSummary = {
      incidentId: "INC-2025-002",
      severity: "SEV2",
      title: "Degraded credit deduction — DLQ depth exceeded threshold",
      startedAt: new Date("2025-06-10T09:00:00Z"),
      detectedAt: new Date("2025-06-10T09:15:00Z"),
      resolvedAt: null,
      affectedSystems: ["credit-deduction", "dlq"],
      affectedTenantCount: 12,
      revenueImpactCents: null,
    };

    const report = generatePostMortemTemplate(incident);

    expect(report.severity).toBe("SEV2");
    expect(report.sections.summary).toContain("TBD"); // revenue impact TBD
    expect(report.sections.resolution).toContain("ONGOING");
    expect(report.markdown).toContain("ONGOING");
  });

  // =========================================================================
  // STEP 8: Communication templates — customer and internal notifications
  // =========================================================================

  it("8. SEV1 customer communication includes action-required subject", () => {
    const context = {
      incidentId: "INC-2025-001",
      startedAt: new Date("2025-06-01T14:00:00Z"),
      affectedSystems: ["stripe-api"],
      customerImpact: "Payment processing unavailable",
      currentStatus: "Investigating",
    };

    const comm = getCustomerTemplate("SEV1", context);

    expect(comm.audience).toBe("customer");
    expect(comm.subject).toContain("[Action Required]");
    expect(comm.subject).toContain("INC-2025-001");
    expect(comm.body).toContain("payment processing outage");
    expect(comm.body).toContain("Payment processing unavailable");
    expect(comm.body).toContain("30 minutes");
  });

  it("8b. SEV2 customer communication is a notice, not action-required", () => {
    const context = {
      incidentId: "INC-2025-002",
      startedAt: new Date("2025-06-10T09:00:00Z"),
      affectedSystems: ["credit-deduction"],
      customerImpact: "Some transactions may be delayed",
      currentStatus: "Investigating root cause",
    };

    const comm = getCustomerTemplate("SEV2", context);

    expect(comm.audience).toBe("customer");
    expect(comm.subject).toContain("[Notice]");
    expect(comm.subject).not.toContain("Action Required");
    expect(comm.body).toContain("delayed");
  });

  it("8c. SEV1 internal communication includes escalation checklist", () => {
    const context = {
      incidentId: "INC-2025-001",
      startedAt: new Date("2025-06-01T14:00:00Z"),
      affectedSystems: ["stripe-api", "gateway"],
      customerImpact: "Revenue processing halted",
      currentStatus: "Stripe API unreachable",
    };

    const comm = getInternalTemplate("SEV1", context);

    expect(comm.audience).toBe("internal");
    expect(comm.subject).toContain("SEV1");
    expect(comm.body).toContain("Page on-call engineer");
    expect(comm.body).toContain("ACK SLA: 5 minutes");
    expect(comm.body).toContain("RESOLVE SLA: 60 minutes");
    expect(comm.body).toContain("stripe-api");
  });

  it("8d. SEV3 internal communication describes monitoring stance", () => {
    const context = {
      incidentId: "INC-2025-003",
      startedAt: new Date("2025-06-15T08:00:00Z"),
      affectedSystems: ["dlq"],
      customerImpact: "No customer impact expected",
      currentStatus: "Monitoring",
    };

    const comm = getInternalTemplate("SEV3", context);

    expect(comm.audience).toBe("internal");
    expect(comm.subject).toContain("SEV3");
    expect(comm.body).toContain("ACK SLA: 60 minutes");
    expect(comm.body).toContain("RESOLVE SLA: 24 hours");
  });

  // =========================================================================
  // EDGE CASE: SEV2 classification from combination of signals
  // =========================================================================

  it("9. classify SEV2 from multiple degraded signals (no single SEV1 trigger)", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: true,
      gatewayErrorRate: 0.12, // 5-50% = degraded range
      creditDeductionFailures: 15, // > 10 threshold
      dlqDepth: 60, // > 50 threshold
      tenantsWithNegativeBalance: 2,
      autoTopupFailures: 4, // >= 3 threshold
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV2");
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    expect(result.reasons.some((r) => r.includes("Credit deduction failures"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("DLQ depth"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("Auto-topup"))).toBe(true);
  });

  // =========================================================================
  // EDGE CASE: SEV3 classification for early warning signals only
  // =========================================================================

  it("10. classify SEV3 for early warning signals", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: true,
      gatewayErrorRate: 0.03, // above 2% warning
      creditDeductionFailures: 2, // > 0 but <= 10
      dlqDepth: 5, // > 0 but <= 50
      tenantsWithNegativeBalance: 8, // > 5 threshold
      autoTopupFailures: 1,
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV3");
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    expect(result.reasons.some((r) => r.includes("DLQ has"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("credit deduction failure"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("negative balance"))).toBe(true);
  });

  // =========================================================================
  // EDGE CASE: All green — SEV3 with no reasons (system healthy)
  // =========================================================================

  it("11. all-green signals produce SEV3 with empty reasons (system healthy)", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: true,
      gatewayErrorRate: 0.0,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV3");
    expect(result.reasons).toHaveLength(0);
  });

  // =========================================================================
  // EDGE CASE: Escalation contact ordering is consistent
  // =========================================================================

  it("12. all severity escalation matrices have monotonically increasing SLA minutes", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3"] as const) {
      const matrix = getEscalationMatrix(sev);
      for (let i = 1; i < matrix.length; i++) {
        expect(matrix[i].slaMinutes).toBeGreaterThanOrEqual(matrix[i - 1].slaMinutes);
      }
      // orders are sequential
      matrix.forEach((c, idx) => {
        expect(c.order).toBe(idx + 1);
      });
    }
  });

  // =========================================================================
  // EDGE CASE: Alert checker getStatus() returns empty before first checkAll
  // =========================================================================

  it("13. AlertChecker.getStatus() returns empty array before first checkAll", () => {
    const alerts = buildAlerts(metrics, fakeFleetEventRepo);
    const checker = new AlertChecker(alerts, { fleetEventRepo: fakeFleetEventRepo });
    expect(checker.getStatus()).toEqual([]);
  });

  // =========================================================================
  // EDGE CASE: webhooksReceiving null (not monitored) does not trigger SEV1
  // =========================================================================

  it("14. webhooksReceiving=null (unmonitored) does not trigger SEV1", () => {
    const result = classifySeverity({
      stripeReachable: true,
      webhooksReceiving: null,
      gatewayErrorRate: 0.0,
      creditDeductionFailures: 0,
      dlqDepth: 0,
      tenantsWithNegativeBalance: 0,
      autoTopupFailures: 0,
      firingAlertCount: 0,
    });

    expect(result.severity).toBe("SEV3");
    expect(result.reasons).toHaveLength(0);
  });
});
