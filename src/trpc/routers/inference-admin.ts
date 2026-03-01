import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ISessionUsageRepository } from "../../inference/session-usage-repository.js";
import { protectedProcedure, router } from "../init.js";

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
  dailyCost: protectedProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateByDay(input.since);
  }),

  pageCost: protectedProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateByPage(input.since);
  }),

  cacheHitRate: protectedProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.cacheHitRate(input.since);
  }),

  sessionCost: protectedProcedure.input(sinceSchema).query(async ({ input }) => {
    const repo = getDeps().getSessionUsageRepo();
    return repo.aggregateSessionCost(input.since);
  }),
});
