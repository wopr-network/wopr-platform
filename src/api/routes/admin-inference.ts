import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { getSessionUsageRepo } from "../../fleet/services.js";
import type { ISessionUsageRepository } from "../../inference/session-usage-repository.js";

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _repo: ISessionUsageRepository | null = null;

function getRepo(): ISessionUsageRepository {
  if (!_repo) {
    _repo = getSessionUsageRepo();
  }
  return _repo;
}

// ---------------------------------------------------------------------------
// Route factory (injectable for tests)
// ---------------------------------------------------------------------------

export function createAdminInferenceRoutes(repoFactory: () => ISessionUsageRepository): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  /**
   * GET /
   * Dashboard summary: daily costs, session count, average session cost, cache hit rate.
   *
   * Query params:
   *   - days: number of days to look back (default: 7)
   */
  routes.get("/", async (c) => {
    const repo = repoFactory();
    const daysParam = c.req.query("days");
    const days = Math.min(90, Math.max(1, Number.isNaN(Number(daysParam)) ? 7 : Number(daysParam)));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      const [dailyCosts, pageCosts, cacheHitRate] = await Promise.all([
        repo.aggregateByDay(since),
        repo.aggregateByPage(since),
        repo.cacheHitRate(since),
      ]);

      const totalCostUsd = dailyCosts.reduce((sum, d) => sum + d.totalCostUsd, 0);
      const totalSessions = dailyCosts.reduce((sum, d) => sum + d.sessionCount, 0);
      const avgCostPerSession = totalSessions > 0 ? totalCostUsd / totalSessions : 0;

      return c.json({
        period: { days, since },
        summary: {
          totalCostUsd,
          totalSessions,
          avgCostPerSessionUsd: avgCostPerSession,
          cacheHitRate,
        },
        dailyCosts,
        pageCosts,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /**
   * GET /daily
   * Daily cost breakdown for the given window.
   *
   * Query params:
   *   - days: number of days to look back (default: 30)
   */
  routes.get("/daily", async (c) => {
    const repo = repoFactory();
    const daysParam = c.req.query("days");
    const days = Math.min(90, Math.max(1, Number.isNaN(Number(daysParam)) ? 30 : Number(daysParam)));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      const dailyCosts = await repo.aggregateByDay(since);
      return c.json({ days, dailyCosts });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /**
   * GET /pages
   * Per-page cost breakdown (friction signal: most expensive pages = friction points).
   *
   * Query params:
   *   - days: number of days to look back (default: 7)
   */
  routes.get("/pages", async (c) => {
    const repo = repoFactory();
    const daysParam = c.req.query("days");
    const days = Math.min(90, Math.max(1, Number.isNaN(Number(daysParam)) ? 7 : Number(daysParam)));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      const pageCosts = await repo.aggregateByPage(since);
      return c.json({ days, pageCosts });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /**
   * GET /cache
   * Cache hit rate over the given window.
   *
   * Query params:
   *   - days: number of days to look back (default: 7)
   */
  routes.get("/cache", async (c) => {
    const repo = repoFactory();
    const daysParam = c.req.query("days");
    const days = Math.min(90, Math.max(1, Number.isNaN(Number(daysParam)) ? 7 : Number(daysParam)));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      const cacheHitRate = await repo.cacheHitRate(since);
      return c.json({ days, cacheHitRate });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  /**
   * GET /session/:sessionId
   * Per-session usage detail (for debugging runaway sessions).
   */
  routes.get("/session/:sessionId", async (c) => {
    const repo = repoFactory();
    const sessionId = c.req.param("sessionId");

    try {
      const records = await repo.findBySessionId(sessionId);
      const totalCostUsd = records.reduce((sum, r) => sum + r.costUsd, 0);
      return c.json({ sessionId, totalCostUsd, records });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
    }
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Pre-built singleton with admin auth
// ---------------------------------------------------------------------------

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

export const adminInferenceRoutes = new Hono<AuthEnv>();
adminInferenceRoutes.use("*", adminAuth);
adminInferenceRoutes.route("/", createAdminInferenceRoutes(getRepo));
