import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ADDON_CATALOG, ADDON_KEYS, type AddonKey } from "../../monetization/addons/addon-catalog.js";
import type { ITenantAddonRepository } from "../../monetization/addons/addon-repository.js";
import { protectedProcedure, router } from "../init.js";

export interface AddonRouterDeps {
  addonRepo: ITenantAddonRepository;
}

let _deps: AddonRouterDeps | null = null;

export function setAddonRouterDeps(deps: AddonRouterDeps): void {
  _deps = deps;
}

function getDeps(): AddonRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Addons not initialized" });
  return _deps;
}

export const addonRouter = router({
  /** List all available add-ons with pricing. */
  catalog: protectedProcedure.query(() => {
    return ADDON_KEYS.map((key) => ({
      key,
      label: ADDON_CATALOG[key].label,
      dailyCostCents: ADDON_CATALOG[key].dailyCost.toCents(),
      description: ADDON_CATALOG[key].description,
    }));
  }),

  /** List enabled add-ons for the authenticated tenant. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.tenantId ?? ctx.user.id;
    const { addonRepo } = getDeps();
    const addons = await addonRepo.list(tenantId);
    return addons.map((a) => ({
      key: a.addonKey,
      label: ADDON_CATALOG[a.addonKey as AddonKey]?.label ?? a.addonKey,
      dailyCostCents: ADDON_CATALOG[a.addonKey as AddonKey]?.dailyCost.toCents() ?? 0,
      enabledAt: a.enabledAt,
    }));
  }),

  /** Enable an add-on. */
  enable: protectedProcedure
    .input(z.object({ key: z.enum([...ADDON_KEYS] as [AddonKey, ...AddonKey[]]) }))
    .mutation(async ({ input, ctx }) => {
      const tenantId = ctx.tenantId ?? ctx.user.id;
      const { addonRepo } = getDeps();
      await addonRepo.enable(tenantId, input.key as AddonKey);
      return { enabled: true, key: input.key };
    }),

  /** Disable an add-on. */
  disable: protectedProcedure
    .input(z.object({ key: z.enum([...ADDON_KEYS] as [AddonKey, ...AddonKey[]]) }))
    .mutation(async ({ input, ctx }) => {
      const tenantId = ctx.tenantId ?? ctx.user.id;
      const { addonRepo } = getDeps();
      await addonRepo.disable(tenantId, input.key as AddonKey);
      return { disabled: true, key: input.key };
    }),
});
