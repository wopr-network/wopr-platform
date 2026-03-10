/**
 * tRPC model selection router — per-tenant default model selection.
 */

import { TRPCError } from "@trpc/server";
import { router, tenantProcedure } from "@wopr-network/platform-core/trpc";
import { z } from "zod";
import type { ITenantModelSelectionRepository } from "../../db/tenant-model-selection-repository.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ModelSelectionRouterDeps {
  getRepository: () => ITenantModelSelectionRepository;
}

let _deps: ModelSelectionRouterDeps | null = null;

export function setModelSelectionRouterDeps(deps: ModelSelectionRouterDeps): void {
  _deps = deps;
}

function deps(): ModelSelectionRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Model selection router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const modelSelectionRouter = router({
  /** Get the default model for the authenticated tenant. */
  getDefaultModel: tenantProcedure.query(async ({ ctx }) => {
    const repo = deps().getRepository();
    return {
      tenantId: ctx.tenantId,
      defaultModel: await repo.getDefaultModel(ctx.tenantId),
    };
  }),

  /** Set the default model for the authenticated tenant. */
  setDefaultModel: tenantProcedure
    .input(z.object({ defaultModel: z.string().min(1).max(256) }))
    .mutation(async ({ input, ctx }) => {
      const repo = deps().getRepository();
      await repo.setDefaultModel(ctx.tenantId, input.defaultModel);
      return { tenantId: ctx.tenantId, defaultModel: input.defaultModel };
    }),
});
