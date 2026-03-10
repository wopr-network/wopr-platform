import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { z } from "zod";
import { getCustomerTemplate, getInternalTemplate } from "../../monetization/incident/communication-templates.js";
import { getEscalationMatrix } from "../../monetization/incident/escalation.js";
import { generatePostMortemTemplate } from "../../monetization/incident/postmortem.js";
import { getResponseProcedure } from "../../monetization/incident/response-procedures.js";
import { classifySeverity } from "../../monetization/incident/severity.js";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

const severitySchema = z.enum(["SEV1", "SEV2", "SEV3"]);

/**
 * Admin API routes for incident response operations.
 * Exposes the existing src/monetization/incident/ module over HTTP.
 */
export const incidentResponseRoutes = new Hono<AuthEnv>();

/**
 * POST /api/admin/incidents/severity
 * Classify severity from provided signals.
 */
incidentResponseRoutes.post("/severity", adminAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = z
      .object({
        stripeReachable: z.boolean(),
        webhooksReceiving: z.boolean().nullable(),
        gatewayErrorRate: z.number(),
        creditDeductionFailures: z.number(),
        dlqDepth: z.number(),
        tenantsWithNegativeBalance: z.number(),
        autoTopupFailures: z.number(),
        firingAlertCount: z.number(),
      })
      .parse(body);

    const result = classifySeverity(parsed);
    return c.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ success: false, error: "Invalid signals payload", details: err.issues }, 400);
    }
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /api/admin/incidents/escalation/:severity
 * Get escalation matrix for a severity level.
 */
incidentResponseRoutes.get("/escalation/:severity", adminAuth, async (c) => {
  const rawSeverity = c.req.param("severity");
  const parsed = severitySchema.safeParse(rawSeverity);
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid severity. Must be SEV1, SEV2, or SEV3" }, 400);
  }
  const contacts = getEscalationMatrix(parsed.data);
  return c.json({ success: true, severity: parsed.data, contacts });
});

/**
 * GET /api/admin/incidents/procedure/:severity
 * Get response procedure for a severity level.
 */
incidentResponseRoutes.get("/procedure/:severity", adminAuth, async (c) => {
  const rawSeverity = c.req.param("severity");
  const parsed = severitySchema.safeParse(rawSeverity);
  if (!parsed.success) {
    return c.json({ success: false, error: "Invalid severity. Must be SEV1, SEV2, or SEV3" }, 400);
  }
  const procedure = getResponseProcedure(parsed.data);
  return c.json({ success: true, procedure });
});

/**
 * POST /api/admin/incidents/communicate
 * Generate communication templates for an incident.
 */
incidentResponseRoutes.post("/communicate", adminAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = z
      .object({
        severity: severitySchema,
        incidentId: z.string().min(1),
        startedAt: z.string().datetime(),
        affectedSystems: z.array(z.string()),
        customerImpact: z.string(),
        currentStatus: z.string(),
      })
      .parse(body);

    const context = {
      incidentId: parsed.incidentId,
      startedAt: new Date(parsed.startedAt),
      affectedSystems: parsed.affectedSystems,
      customerImpact: parsed.customerImpact,
      currentStatus: parsed.currentStatus,
    };

    const customer = getCustomerTemplate(parsed.severity, context);
    const internal = getInternalTemplate(parsed.severity, context);
    return c.json({ success: true, templates: { customer, internal } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ success: false, error: "Invalid payload", details: err.issues }, 400);
    }
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * POST /api/admin/incidents/postmortem
 * Generate a post-mortem template for an incident.
 */
incidentResponseRoutes.post("/postmortem", adminAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsed = z
      .object({
        incidentId: z.string().min(1),
        severity: severitySchema,
        title: z.string().min(1),
        startedAt: z.string().datetime(),
        detectedAt: z.string().datetime(),
        resolvedAt: z.string().datetime().nullable(),
        affectedSystems: z.array(z.string()),
        affectedTenantCount: z.number().int().min(0),
        revenueImpactCents: z.number().int().nullable(),
      })
      .parse(body);

    const report = generatePostMortemTemplate({
      incidentId: parsed.incidentId,
      severity: parsed.severity,
      title: parsed.title,
      startedAt: new Date(parsed.startedAt),
      detectedAt: new Date(parsed.detectedAt),
      resolvedAt: parsed.resolvedAt ? new Date(parsed.resolvedAt) : null,
      affectedSystems: parsed.affectedSystems,
      affectedTenantCount: parsed.affectedTenantCount,
      revenueImpactCents: parsed.revenueImpactCents,
    });

    return c.json({ success: true, report });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ success: false, error: "Invalid payload", details: err.issues }, 400);
    }
    return c.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
