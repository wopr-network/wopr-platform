/**
 * tRPC fleet router — list/get/create/control bot instances, logs, metrics, and templates.
 *
 * Delegates to the existing FleetManager service layer — no business logic is duplicated.
 * Follows the dependency injection pattern established by billing.ts, account.ts, and capabilities.ts.
 *
 * Known gaps (deferred to follow-up stories):
 * - Credit/quota checks (present in REST routes) are NOT included here. The FleetManager's
 *   create() and start() methods do not include credit checks — those live in the REST handler.
 *   TODO: extract credit/quota checks to a shared service layer.
 * - Proxy registration (getProxyManager().addRoute()) and health update side-effects from
 *   the REST create/start/stop handlers are NOT replicated here.
 *   TODO: extract these side effects into FleetManager or a shared service layer.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { FleetManager } from "../../fleet/fleet-manager.js";
import { BotNotFoundError } from "../../fleet/fleet-manager.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import { createBotSchema } from "../../fleet/types.js";
import { protectedProcedure, router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const controlActionSchema = z.enum(["start", "stop", "restart"]);

const tailSchema = z.number().int().min(1).max(10_000).default(100);

// ---------------------------------------------------------------------------
// Deps — injected at startup
// ---------------------------------------------------------------------------

export interface FleetRouterDeps {
  getFleetManager: () => FleetManager;
  getTemplates: () => ProfileTemplate[];
}

let _deps: FleetRouterDeps | null = null;

export function setFleetRouterDeps(deps: FleetRouterDeps): void {
  _deps = deps;
}

function deps(): FleetRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Fleet not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const fleetRouter = router({
  /** List all bot instances with live status. Tenant-scoped: only returns bots for ctx.tenantId. */
  listInstances: tenantProcedure.query(async ({ ctx }) => {
    const fleet = deps().getFleetManager();
    const bots = await fleet.listByTenant(ctx.tenantId);
    return { bots };
  }),

  /** Get a single bot instance by ID with live status. */
  getInstance: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    try {
      // Verify ownership: get profile, check tenantId matches ctx.tenantId
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      return await fleet.status(input.id);
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      if (err instanceof BotNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      throw err;
    }
  }),

  /** Create a new bot instance. Uses the existing createBotSchema from fleet/types.ts. */
  createInstance: tenantProcedure.input(createBotSchema.omit({ tenantId: true })).mutation(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    try {
      const profile = await fleet.create({ ...input, tenantId: ctx.tenantId });
      return profile;
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Failed to create bot",
      });
    }
  }),

  /** Control a bot instance: start, stop, or restart. */
  controlInstance: tenantProcedure
    .input(z.object({ id: uuidSchema, action: controlActionSchema }))
    .mutation(async ({ input, ctx }) => {
      const fleet = deps().getFleetManager();
      // Verify tenant ownership
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      try {
        switch (input.action) {
          case "start":
            await fleet.start(input.id);
            break;
          case "stop":
            await fleet.stop(input.id);
            break;
          case "restart":
            await fleet.restart(input.id);
            break;
        }
        return { ok: true };
      } catch (err) {
        if (err instanceof BotNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Get health status for a bot instance (delegates to fleet.status). */
  getInstanceHealth: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    try {
      const status = await fleet.status(input.id);
      return {
        id: status.id,
        state: status.state,
        health: status.health,
        uptime: status.uptime,
        stats: status.stats,
      };
    } catch (err) {
      if (err instanceof BotNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      throw err;
    }
  }),

  /** Get container logs for a bot instance. */
  getInstanceLogs: tenantProcedure
    .input(z.object({ id: uuidSchema, tail: tailSchema.optional() }))
    .query(async ({ input, ctx }) => {
      const fleet = deps().getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      try {
        const logs = await fleet.logs(input.id, input.tail ?? 100);
        return { logs };
      } catch (err) {
        if (err instanceof BotNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Get resource usage metrics for a bot instance. */
  getInstanceMetrics: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    try {
      const status = await fleet.status(input.id);
      return {
        id: status.id,
        stats: status.stats,
      };
    } catch (err) {
      if (err instanceof BotNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      throw err;
    }
  }),

  /** List available profile templates. */
  listTemplates: protectedProcedure.query(() => {
    const templates = deps().getTemplates();
    return { templates };
  }),
});
