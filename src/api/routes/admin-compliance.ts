import { Hono } from "hono";
import type { EvidenceCollector } from "../../compliance/evidence-collector.js";

/**
 * Create admin compliance routes.
 *
 * GET /evidence?from=ISO&to=ISO — Generate SOC 2 evidence report for the given period.
 * Defaults to last 90 days if no params provided.
 */
export function createAdminComplianceRoutes(collector: EvidenceCollector): Hono {
  const routes = new Hono();

  routes.get("/evidence", async (c) => {
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const fromParam = c.req.query("from");
    const toParam = c.req.query("to");

    if (fromParam !== undefined && Number.isNaN(new Date(fromParam).getTime())) {
      return c.json({ error: "Invalid 'from' date" }, 400);
    }
    if (toParam !== undefined && Number.isNaN(new Date(toParam).getTime())) {
      return c.json({ error: "Invalid 'to' date" }, 400);
    }

    const from = fromParam ?? ninetyDaysAgo.toISOString();
    const to = toParam ?? now.toISOString();

    const report = await collector.collect({ from, to });
    return c.json(report);
  });

  return routes;
}
