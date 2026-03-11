import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "@wopr-network/platform-core/trpc";
import { z } from "zod";
import type { IMarketplacePluginRepository } from "../../marketplace/marketplace-plugin-repository.js";
import { rollbackPluginOnVolume, upgradePluginOnVolume } from "../../marketplace/volume-installer.js";

export interface MarketplaceRouterDeps {
  getMarketplacePluginRepo: () => IMarketplacePluginRepository;
  getPluginVolumePath: () => string;
}

let _deps: MarketplaceRouterDeps | null = null;

export function setMarketplaceRouterDeps(deps: MarketplaceRouterDeps): void {
  _deps = deps;
}

function deps(): MarketplaceRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Marketplace router not initialized" });
  return _deps;
}

export const marketplaceRouter = router({
  /** Upgrade an installed plugin to a target version, preserving the previous version for rollback. */
  upgrade: adminProcedure
    .input(
      z.object({
        pluginId: z.string().min(1),
        targetVersion: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const repo = deps().getMarketplacePluginRepo();
      const volumePath = deps().getPluginVolumePath();

      const plugin = await repo.findById(input.pluginId);
      if (!plugin) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Plugin not found: ${input.pluginId}` });
      }

      await upgradePluginOnVolume({
        pluginId: input.pluginId,
        npmPackage: plugin.npmPackage,
        targetVersion: input.targetVersion,
        volumePath,
        repo,
      });

      const updated = await repo.findById(input.pluginId);
      return updated;
    }),

  /** Roll back a plugin to its previous version. */
  rollback: adminProcedure
    .input(
      z.object({
        pluginId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const repo = deps().getMarketplacePluginRepo();
      const volumePath = deps().getPluginVolumePath();

      const plugin = await repo.findById(input.pluginId);
      if (!plugin) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Plugin not found: ${input.pluginId}` });
      }
      if (!plugin.previousVersion) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No previous version recorded for plugin: ${input.pluginId}`,
        });
      }

      await rollbackPluginOnVolume({
        pluginId: input.pluginId,
        npmPackage: plugin.npmPackage,
        previousVersion: plugin.previousVersion,
        volumePath,
        repo,
      });

      const updated = await repo.findById(input.pluginId);
      return updated;
    }),
});
