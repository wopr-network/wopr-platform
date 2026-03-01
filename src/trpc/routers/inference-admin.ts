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
    const rate = await repo.cacheHitRate(input.since);
    return { rate };
  }),

  sessionCost: adminProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateSessionCost(input.since);
  }),
});
