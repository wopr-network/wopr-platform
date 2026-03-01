import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ISessionUsageRepository } from "../../inference/session-usage-repository.js";
import { adminProcedure, router } from "../init.js";

export interface InferenceAdminDeps {
  getSessionUsageRepo: () => ISessionUsageRepository;
}

let _deps: InferenceAdminDeps | null = null;

export function setInferenceAdminDeps(deps: InferenceAdminDeps): void {
  _deps = deps;
}

function getDeps(): InferenceAdminDeps {
  if (!_deps)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "InferenceAdmin not initialized",
    });
  return _deps;
}

const sinceSchema = z.object({
  since: z.number().int().min(0).describe("Unix epoch ms — return data newer than this"),
});

/**
 * Inference admin router — cost analytics dashboard.
 *
 * All procedures use adminProcedure (platform_admin role required).
 * Admins intentionally have cross-tenant visibility for the cost dashboard
 * use case — these endpoints return aggregate summaries, not per-tenant data.
 *
 * SECURITY: If a non-admin session cost lookup is ever added, it MUST enforce
 * tenant ownership:
 *   const session = await inferenceRepo.getSession(input.sessionId);
 *   if (session.tenantId !== ctx.tenantId) throw new TRPCError({ code: "FORBIDDEN" });
 */
export const inferenceAdminRouter = router({
  dailyCost: adminProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateByDay(input.since);
  }),

  pageCost: adminProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateByPage(input.since);
  }),

  cacheHitRate: adminProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.cacheHitRate(input.since);
  }),

  sessionCost: adminProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateSessionCost(input.since);
  }),
});
