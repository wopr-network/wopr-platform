/**
 * tRPC fleet router — list/get/create/control bot instances, logs, metrics, and templates.
 *
 * Delegates to the existing FleetManager service layer — no business logic is duplicated.
 * Follows the dependency injection pattern established by billing.ts, account.ts, and capabilities.ts.
 *
 * Proxy side-effects (addRoute, removeRoute, updateHealth) are handled inside FleetManager
 * so both REST and tRPC paths get subdomain routing automatically.
 */

import { TRPCError } from "@trpc/server";
import type { RoleStore } from "@wopr-network/platform-core/admin";
import { createStripeClient, createVpsCheckoutSession, loadStripeConfig } from "@wopr-network/platform-core/billing";
import type { ILedger as CreditLedger } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import type { IBotInstanceRepository } from "@wopr-network/platform-core/fleet/bot-instance-repository";
import { CAPABILITY_ENV_MAP } from "@wopr-network/platform-core/fleet/capability-env-map";
import type { FleetManager } from "@wopr-network/platform-core/fleet/fleet-manager";
import { BotNotFoundError } from "@wopr-network/platform-core/fleet/fleet-manager";
import type { ImagePoller } from "@wopr-network/platform-core/fleet/image-poller";
import type { INodeRepository } from "@wopr-network/platform-core/fleet/node-repository";
import { findPlacement } from "@wopr-network/platform-core/fleet/placement";
import type { ProfileTemplate } from "@wopr-network/platform-core/fleet/profile-schema";
import {
  RESOURCE_TIERS,
  type ResourceTierKey,
  tierToResourceLimits,
} from "@wopr-network/platform-core/fleet/resource-tiers";
import { getVpsRepo } from "@wopr-network/platform-core/fleet/services";
import { STORAGE_TIERS, type StorageTierKey } from "@wopr-network/platform-core/fleet/storage-tiers";
import { createBotSchema, updateBotSchema } from "@wopr-network/platform-core/fleet/types";
import type { ContainerUpdater } from "@wopr-network/platform-core/fleet/updater";
import type { IServiceKeyRepository } from "@wopr-network/platform-core/gateway/index";
import type { IBotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import {
  checkInstanceQuota,
  DEFAULT_INSTANCE_LIMITS,
} from "@wopr-network/platform-core/monetization/quotas/quota-check";
import { buildResourceLimits } from "@wopr-network/platform-core/monetization/quotas/resource-limits";
import { assertSafeRedirectUrl } from "@wopr-network/platform-core/security";
import { adminProcedure, protectedProcedure, router, tenantProcedure } from "@wopr-network/platform-core/trpc";
import { z } from "zod";
import { removeInstance } from "../../fleet/fleet-remove.js";
import { getTenantCustomerRepository } from "../../platform-services.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const controlActionSchema = z.enum(["start", "stop", "restart", "destroy"]);

const tailSchema = z.number().int().min(1).max(10_000).default(100);

// ---------------------------------------------------------------------------
// Deps — injected at startup
// ---------------------------------------------------------------------------

export interface FleetRouterDeps {
  getFleetManager: () => FleetManager;
  getTemplates: () => ProfileTemplate[];
  getCreditLedger: () => CreditLedger | null;
  getBotBilling?: () => IBotBilling | null;
  getBotInstanceRepo?: () => IBotInstanceRepository | null;
  getRoleStore?: () => RoleStore | null;
  getNodeRepo?: () => INodeRepository | null;
  getImagePoller?: () => ImagePoller | null;
  getUpdater?: () => ContainerUpdater | null;
  getServiceKeyRepo?: () => IServiceKeyRepository | null;
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

const listInstancesInputSchema = z.object({
  limit: z.number().int().min(1).max(250).default(50),
  cursor: z.string().uuid().optional(),
});

export const fleetRouter = router({
  /** List all bot instances with live status. Tenant-scoped: only returns bots for ctx.tenantId.
   *  Supports cursor-based pagination: pass `cursor` (bot id) and `limit` (default 50, max 250).
   *  Returns `hasNextPage` and `nextCursor` for fetching subsequent pages. */
  listInstances: tenantProcedure.input(listInstancesInputSchema.optional()).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const allBots = await fleet.listByTenant(ctx.tenantId);

    const limit = input?.limit ?? 50;
    const cursor = input?.cursor;

    // Sort by id for stable ordering
    allBots.sort((a, b) => a.id.localeCompare(b.id));

    // Find cursor position and slice
    let startIndex = 0;
    if (cursor) {
      const idx = allBots.findIndex((b) => b.id === cursor);
      if (idx !== -1) startIndex = idx + 1;
    }

    const page = allBots.slice(startIndex, startIndex + limit);
    const hasNextPage = startIndex + limit < allBots.length;
    const nextCursor = hasNextPage ? page[page.length - 1]?.id : undefined;

    return { bots: page, hasNextPage, nextCursor };
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
    const { getFleetManager, getCreditLedger } = deps();
    const fleet = getFleetManager();

    // Payment gate (WOP-380): require minimum 17 cents (1 day of bot runtime)
    try {
      const ledger = getCreditLedger();
      if (ledger) {
        const balance = await ledger.balance(ctx.tenantId);
        if (balance.lessThan(Credit.fromCents(17))) {
          throw new TRPCError({
            code: "PAYMENT_REQUIRED",
            message: "Insufficient credits",
            cause: { balance, required: 17, buyUrl: "/dashboard/credits" },
          });
        }

        // Quota check: count active instances for this tenant
        const allProfiles = await fleet.profiles.list();
        const activeInstances = allProfiles.filter((p) => p.tenantId === ctx.tenantId).length;
        const quotaResult = checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, activeInstances);
        if (!quotaResult.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: quotaResult.reason ?? "Instance quota exceeded",
            cause: {
              currentInstances: quotaResult.currentInstances,
              maxInstances: quotaResult.maxInstances,
            },
          });
        }
      }
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      // Billing DB unavailable (e.g., in tests) — skip quota enforcement
    }

    // Placement: find best node for this bot
    let nodeId: string | undefined;
    try {
      const nodeRepo = deps().getNodeRepo?.();
      if (nodeRepo) {
        const activeNodes = await nodeRepo.list(["active"]);
        const resourceLimits = buildResourceLimits();
        const requiredMb = resourceLimits.Memory ? Math.ceil(resourceLimits.Memory / (1024 * 1024)) : 100;
        const placement = findPlacement(activeNodes, requiredMb);
        if (!placement) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "No node has sufficient capacity",
          });
        }
        nodeId = placement.nodeId;
      }
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      // Re-throw unexpected errors (DB failures, network errors, etc.)
      // Only silently skip when nodeRepo is simply not wired (getNodeRepo?.() returned null/undefined above)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Placement failed",
        cause: err,
      });
    }

    try {
      const profile = await fleet.create({ ...input, tenantId: ctx.tenantId, nodeId });

      // Generate a per-instance gateway service key for metered inference.
      // Failures must not block instance creation — the key can be regenerated later.
      let gatewayKey: string | undefined;
      try {
        const keyRepo = deps().getServiceKeyRepo?.();
        if (keyRepo) {
          gatewayKey = await keyRepo.generate(ctx.tenantId, profile.id);
        }
      } catch {
        // Key generation failed — instance is still usable, just without gateway access
      }

      return { ...profile, ...(gatewayKey ? { gatewayKey } : {}) };
    } catch (err) {
      if (err instanceof TRPCError) throw err;
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
      const { getFleetManager, getCreditLedger, getBotInstanceRepo, getRoleStore } = deps();
      const fleet = getFleetManager();
      // Verify tenant ownership
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      // WOP-1002: user-scoped ownership — regular users can only control their own bots
      if (ctx.user?.id) {
        const botRepo = getBotInstanceRepo?.();
        const roleStore = getRoleStore?.();
        if (botRepo && roleStore) {
          const instance = await botRepo.getById(input.id);
          const role = await roleStore.getRole(ctx.user.id, ctx.tenantId);
          if (role === "user" && instance?.createdByUserId && instance.createdByUserId !== ctx.user.id) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to manage this bot" });
          }
        }
      }
      // Payment gate (WOP-380): require minimum 17 cents to start a bot
      if (input.action === "start") {
        try {
          const ledger = getCreditLedger();
          if (ledger) {
            const balance = await ledger.balance(ctx.tenantId);
            if (balance.lessThan(Credit.fromCents(17))) {
              throw new TRPCError({
                code: "PAYMENT_REQUIRED",
                message: "Insufficient credits",
                cause: { balance, required: 17, buyUrl: "/dashboard/credits" },
              });
            }
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          // Billing DB unavailable — skip credit check
        }
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
          case "destroy": {
            await removeInstance(fleet, deps().getServiceKeyRepo?.(), input.id);
            break;
          }
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

  /** Get container logs for a bot instance. Returns lines as string array. */
  getInstanceLogs: tenantProcedure
    .input(z.object({ id: uuidSchema, tail: tailSchema.optional() }))
    .query(async ({ input, ctx }) => {
      const fleet = deps().getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      try {
        const raw = await fleet.logs(input.id, input.tail ?? 100);
        const logs = raw.split("\n").filter((line) => line.length > 0);
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

  /** Get full bot settings (identity, capabilities, plugins, status). */
  getSettings: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }

    // Get live status
    let botState: "running" | "stopped" | "archived" = "stopped";
    try {
      const status = await fleet.status(input.id);
      botState = status.state === "running" ? "running" : "stopped";
    } catch (err) {
      if (!(err instanceof BotNotFoundError)) throw err;
      // No container = stopped
    }

    // Parse installed plugins from env
    const pluginIds = (profile.env.WOPR_PLUGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const disabledSet = new Set(
      (profile.env.WOPR_PLUGINS_DISABLED || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const installedPlugins = pluginIds.map((id) => ({
      id,
      name: id,
      description: "",
      icon: "",
      status: (disabledSet.has(id) ? "disabled" : "active") as "active" | "disabled",
      capabilities: [] as string[],
    }));

    // Parse active capabilities from CAPABILITY_ENV_MAP
    const hostedKeys = new Set(
      (profile.env.WOPR_HOSTED_KEYS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const activeSuperpowers: Array<{
      id: string;
      name: string;
      icon: string;
      mode: "hosted" | "byok";
      provider: string;
      model: string;
      usageCount: number;
      usageLabel: string;
      spend: number;
    }> = [];
    const activeCapabilityIds = new Set<string>();

    for (const [capId, entry] of Object.entries(CAPABILITY_ENV_MAP)) {
      if (profile.env[entry.envKey]) {
        activeCapabilityIds.add(capId);
        activeSuperpowers.push({
          id: capId,
          name: capId,
          icon: "zap",
          mode: hostedKeys.has(entry.envKey) ? "hosted" : "byok",
          provider: entry.vaultProvider,
          model: "",
          usageCount: 0,
          usageLabel: "0 calls",
          spend: 0,
        });
      }
    }

    const availableSuperpowers = Object.keys(CAPABILITY_ENV_MAP)
      .filter((id) => !activeCapabilityIds.has(id))
      .map((id) => ({
        id,
        name: id,
        icon: "zap",
        description: `Add ${id} capability to your bot`,
        pricing: "Usage-based",
      }));

    return {
      id: profile.id,
      identity: {
        name: profile.name,
        avatar: "",
        personality: "",
      },
      brain: {
        provider: profile.env.WOPR_LLM_PROVIDER || "none",
        model: profile.env.WOPR_LLM_MODEL || "none",
        mode: (hostedKeys.has("OPENROUTER_API_KEY") ? "hosted" : "byok") as "hosted" | "byok",
        costPerMessage: "~$0.001",
        description: "",
      },
      channels: [] as Array<{
        id: string;
        type: string;
        name: string;
        status: "connected" | "disconnected" | "always-on";
        stats: string;
      }>,
      availableChannels: [],
      activeSuperpowers,
      availableSuperpowers,
      installedPlugins,
      discoverPlugins: [] as Array<{
        id: string;
        name: string;
        description: string;
        icon: string;
        needs: string[];
      }>,
      usage: {
        totalSpend: 0,
        creditBalance: 0,
        capabilities: [],
        trend: [],
      },
      status: botState,
    };
  }),

  /** Update bot identity (name, avatar, personality). */
  updateIdentity: tenantProcedure
    .input(
      z.object({
        id: uuidSchema,
        name: z.string().min(1).max(63),
        avatar: z.string().max(2048).default(""),
        personality: z.string().max(4096).default(""),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const fleet = deps().getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      try {
        const updated = await fleet.update(input.id, {
          name: input.name,
          description: input.personality,
        });
        return {
          name: updated.name,
          avatar: input.avatar,
          personality: updated.description,
        };
      } catch (err) {
        if (err instanceof BotNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** List all available resource tiers with their metadata. */
  listResourceTiers: tenantProcedure.query(() => {
    return Object.entries(RESOURCE_TIERS).map(([key, cfg]) => ({
      key,
      label: cfg.label,
      memoryLimitMb: cfg.memoryLimitMb,
      cpuQuota: cfg.cpuQuota,
      dailyCost: cfg.dailyCost.toCents(),
      description: cfg.description,
    }));
  }),

  /** Get current resource tier for a bot. */
  getResourceTier: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const { getFleetManager, getBotInstanceRepo } = deps();
    const fleet = getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    const repo = getBotInstanceRepo?.();
    const tier = repo?.getResourceTier(input.id) ?? "standard";
    return { tier };
  }),

  /** Upgrade or downgrade resource tier for a bot. */
  setResourceTier: tenantProcedure
    .input(
      z.object({
        id: uuidSchema,
        tier: z.enum(["standard", "pro", "power", "beast"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { getFleetManager, getCreditLedger, getBotInstanceRepo } = deps();
      const fleet = getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }

      const tierConfig = RESOURCE_TIERS[input.tier];

      // Credit check for non-standard tiers
      if (!tierConfig.dailyCost.isZero()) {
        try {
          const ledger = getCreditLedger();
          if (ledger) {
            const balance = await ledger.balance(ctx.tenantId);
            if (balance.lessThan(tierConfig.dailyCost)) {
              throw new TRPCError({
                code: "PAYMENT_REQUIRED",
                message: "Insufficient credits for this resource tier",
                cause: {
                  balance,
                  required: tierConfig.dailyCost.toCents(),
                  buyUrl: "/dashboard/credits",
                },
              });
            }
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          // Billing DB unavailable — skip credit check
        }
      }

      // Remember previous tier for rollback
      const repo = getBotInstanceRepo?.();
      const previousTier: string = (await repo?.getResourceTier(input.id)) ?? "standard";

      // Update billing record
      await repo?.setResourceTier(input.id, input.tier);

      // Restart container with new resource limits (if bot has a container)
      try {
        const limits = tierToResourceLimits(input.tier);
        const status = await fleet.status(input.id);
        const wasRunning = status.state === "running";
        if (status.containerId) {
          if (wasRunning) await fleet.stop(input.id);
          await fleet.remove(input.id, false);
        }
        const { id: _id, ...profileWithoutId } = profile;
        try {
          const newProfile = await fleet.create({ ...profileWithoutId, id: profile.id }, limits);
          if (wasRunning) await fleet.start(newProfile.id);
        } catch (createErr) {
          // New container failed — attempt to re-create with old tier limits to restore service
          const oldLimits = tierToResourceLimits(previousTier as ResourceTierKey);
          try {
            const restoredProfile = await fleet.create({ ...profileWithoutId, id: profile.id }, oldLimits);
            if (wasRunning) await fleet.start(restoredProfile.id);
          } catch (recreateErr) {
            // Re-create with old tier also failed — log critical so ops can manually recover
            const { logger } = await import("@wopr-network/platform-core/config/logger");
            logger.error(
              `CRITICAL: container lost after tier change — manual recovery required. botId=${input.id} newTier=${input.tier} previousTier=${previousTier} createErr=${String(createErr)} recreateErr=${String(recreateErr)}`,
            );
          }
          // Revert billing record regardless of re-create outcome
          repo?.setResourceTier(input.id, previousTier);
          if (createErr instanceof TRPCError) throw createErr;
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to apply resource tier — rolled back",
          });
        }
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        // Outer catch: stop/remove failed — revert billing record
        repo?.setResourceTier(input.id, previousTier);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to apply resource tier — rolled back",
        });
      }

      return { tier: input.tier, dailyCost: tierConfig.dailyCost.toCents() };
    }),

  /** Get current storage tier for a bot. */
  getStorageTier: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const { getFleetManager, getBotBilling } = deps();
    const fleet = getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    const billing = getBotBilling?.() ?? null;
    const tierKey = ((await billing?.getStorageTier(input.id)) ?? "standard") as StorageTierKey;
    const tierConfig = STORAGE_TIERS[tierKey] ?? STORAGE_TIERS.standard;
    return {
      tier: tierKey,
      limitGb: tierConfig.storageLimitGb,
      dailyCost: tierConfig.dailyCost.toCents(),
    };
  }),

  /** Upgrade or downgrade storage tier for a bot. */
  setStorageTier: tenantProcedure
    .input(
      z.object({
        id: uuidSchema,
        tier: z.enum(["standard", "plus", "pro", "max"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { getFleetManager, getCreditLedger, getBotBilling } = deps();
      const fleet = getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }

      const newTierConfig = STORAGE_TIERS[input.tier];
      const billing = getBotBilling?.() ?? null;
      const currentTierKey = ((await billing?.getStorageTier(input.id)) ?? "standard") as StorageTierKey;
      const currentTierConfig = STORAGE_TIERS[currentTierKey] ?? STORAGE_TIERS.standard;

      // Downgrade check: is current usage > new tier limit?
      const isDowngrade = newTierConfig.storageLimitGb < currentTierConfig.storageLimitGb;
      if (isDowngrade) {
        const usage = await fleet.getVolumeUsage(input.id);
        if (usage) {
          const usedGb = usage.usedBytes / 1024 ** 3;
          if (usedGb > newTierConfig.storageLimitGb) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Cannot downgrade: currently using ${usedGb.toFixed(1)} GB, but ${newTierConfig.label} tier only allows ${newTierConfig.storageLimitGb} GB. Free up disk space first.`,
            });
          }
        }
      }

      // Credit check for non-standard tiers
      if (!newTierConfig.dailyCost.isZero()) {
        const ledger = getCreditLedger();
        if (ledger) {
          const balance = await ledger.balance(ctx.tenantId);
          if (balance.lessThan(newTierConfig.dailyCost)) {
            throw new TRPCError({
              code: "PAYMENT_REQUIRED",
              message: "Insufficient credits for this storage tier",
              cause: {
                balance,
                required: newTierConfig.dailyCost.toCents(),
                buyUrl: "/dashboard/credits",
              },
            });
          }
        }
      }

      if (billing) {
        await billing.setStorageTier(input.id, input.tier);
      }

      return {
        tier: input.tier,
        limitGb: newTierConfig.storageLimitGb,
        dailyCost: newTierConfig.dailyCost.toCents(),
      };
    }),

  /** Get live storage usage for a bot. */
  getStorageUsage: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const { getFleetManager, getBotBilling } = deps();
    const fleet = getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }

    const billing = getBotBilling?.() ?? null;
    const tierKey = ((await billing?.getStorageTier(input.id)) ?? "standard") as StorageTierKey;
    const tierConfig = STORAGE_TIERS[tierKey] ?? STORAGE_TIERS.standard;

    const usage = await fleet.getVolumeUsage(input.id);
    const usedBytes = usage?.usedBytes ?? 0;
    const usedGb = usedBytes / 1024 ** 3;
    const limitGb = tierConfig.storageLimitGb;
    const percentUsed = limitGb > 0 ? Math.round((usedGb / limitGb) * 100) : 0;

    return {
      tier: tierKey,
      limitGb,
      usedBytes,
      usedGb: Math.round(usedGb * 100) / 100,
      percentUsed: Math.min(percentUsed, 100),
      dailyCost: tierConfig.dailyCost.toCents(),
    };
  }),
  /** Update bot configuration (name, image, env, etc.). */
  updateInstance: tenantProcedure
    .input(z.object({ id: uuidSchema }).and(updateBotSchema))
    .mutation(async ({ input, ctx }) => {
      const { getFleetManager, getBotInstanceRepo, getRoleStore } = deps();
      const fleet = getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      // User-scoped ownership (WOP-1002)
      if (ctx.user?.id) {
        const botRepo = getBotInstanceRepo?.();
        const roleStore = getRoleStore?.();
        if (botRepo && roleStore) {
          const instance = await botRepo.getById(input.id);
          const role = await roleStore.getRole(ctx.user.id, ctx.tenantId);
          if (role === "user" && instance?.createdByUserId && instance.createdByUserId !== ctx.user.id) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to manage this bot" });
          }
        }
      }
      const { id: _id, ...updates } = input;
      if (Object.keys(updates).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No fields to update" });
      }
      try {
        return await fleet.update(input.id, updates);
      } catch (err) {
        if (err instanceof BotNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Remove (destroy) a bot instance and optionally its volumes. */
  removeInstance: tenantProcedure
    .input(z.object({ id: uuidSchema, removeVolumes: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const { getFleetManager, getBotInstanceRepo, getRoleStore } = deps();
      const fleet = getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }
      // User-scoped ownership (WOP-1002)
      if (ctx.user?.id) {
        const botRepo = getBotInstanceRepo?.();
        const roleStore = getRoleStore?.();
        if (botRepo && roleStore) {
          const instance = await botRepo.getById(input.id);
          const role = await roleStore.getRole(ctx.user.id, ctx.tenantId);
          if (role === "user" && instance?.createdByUserId && instance.createdByUserId !== ctx.user.id) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to manage this bot" });
          }
        }
      }
      try {
        await removeInstance(fleet, deps().getServiceKeyRepo?.(), input.id, input.removeVolumes);

        return { ok: true };
      } catch (err) {
        if (err instanceof BotNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Restart a running bot instance. */
  restartInstance: tenantProcedure.input(z.object({ id: uuidSchema })).mutation(async ({ input, ctx }) => {
    const { getFleetManager, getBotInstanceRepo, getRoleStore } = deps();
    const fleet = getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    // User-scoped ownership (WOP-1002)
    if (ctx.user?.id) {
      const botRepo = getBotInstanceRepo?.();
      const roleStore = getRoleStore?.();
      if (botRepo && roleStore) {
        const instance = await botRepo.getById(input.id);
        const role = await roleStore.getRole(ctx.user.id, ctx.tenantId);
        if (role === "user" && instance?.createdByUserId && instance.createdByUserId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to manage this bot" });
        }
      }
    }
    try {
      await fleet.restart(input.id);
      return { ok: true };
    } catch (err) {
      if (err instanceof BotNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      throw err;
    }
  }),

  activateCapability: tenantProcedure
    .input(z.object({ id: uuidSchema, capabilityId: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const capEntry = CAPABILITY_ENV_MAP[input.capabilityId];
      if (!capEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown capability: ${input.capabilityId}`,
        });
      }

      const fleet = deps().getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }

      // If capability is already active, return early
      const activeKey = `WOPR_CAP_${input.capabilityId.toUpperCase().replace(/-/g, "_")}_ACTIVE`;
      if (profile.env[activeKey]) {
        return { success: true, capabilityId: input.capabilityId, alreadyActive: true };
      }

      try {
        await fleet.update(input.id, {
          env: {
            ...profile.env,
            [`WOPR_CAP_${input.capabilityId.toUpperCase().replace(/-/g, "_")}_ACTIVE`]: "1",
          },
        });
        return { success: true, capabilityId: input.capabilityId, alreadyActive: false };
      } catch (err) {
        if (err instanceof BotNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Initiate VPS tier upgrade for a bot — returns Stripe Checkout URL. */
  upgradeToVps: tenantProcedure
    .input(
      z.object({
        id: uuidSchema,
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const fleet = deps().getFleetManager();
      const profile = await fleet.profiles.get(input.id);
      if (!profile || profile.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
      }

      const vpsPriceId = process.env.STRIPE_VPS_PRICE_ID;
      if (!vpsPriceId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "VPS tier not configured" });
      }

      const vpsRepo = getVpsRepo();
      const existing = await vpsRepo.getByBotId(input.id);
      if (existing && existing.status === "active") {
        throw new TRPCError({ code: "CONFLICT", message: "Bot already on VPS tier" });
      }

      const tenantRepo = getTenantCustomerRepository();
      const customer = await tenantRepo.getByTenant(ctx.tenantId);
      if (!customer) {
        throw new TRPCError({
          code: "PAYMENT_REQUIRED",
          message: "No payment method on file. Please add a payment method first.",
        });
      }

      const stripeConfig = loadStripeConfig();
      if (!stripeConfig) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe not configured" });
      }

      const baseUrl = process.env.PLATFORM_UI_URL ?? "https://app.wopr.bot";
      const successUrl = input.successUrl ?? `${baseUrl}/dashboard/bots/${input.id}?vps=activated`;
      const cancelUrl = input.cancelUrl ?? `${baseUrl}/dashboard/bots/${input.id}`;

      if (input.successUrl) {
        try {
          assertSafeRedirectUrl(input.successUrl);
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid redirect URL" });
        }
      }
      if (input.cancelUrl) {
        try {
          assertSafeRedirectUrl(input.cancelUrl);
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid redirect URL" });
        }
      }

      const session = await createVpsCheckoutSession(createStripeClient(stripeConfig), tenantRepo, {
        tenant: ctx.tenantId,
        botId: input.id,
        vpsPriceId,
        successUrl,
        cancelUrl,
      });

      return { url: session.url, sessionId: session.id };
    }),

  /** Get VPS subscription info for a bot. */
  vpsInfo: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }

    const vpsRepo = getVpsRepo();
    const sub = await vpsRepo.getByBotId(input.id);
    if (!sub) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot is not on VPS tier" });
    }

    const sshConnectionString = sub.sshPublicKey
      ? `ssh root@${sub.hostname ?? `${input.id}.bot.wopr.bot`} -p 22`
      : null;

    return {
      botId: sub.botId,
      status: sub.status,
      hostname: sub.hostname,
      sshConnectionString,
      diskSizeGb: sub.diskSizeGb,
      createdAt: sub.createdAt,
    };
  }),

  /** Get image update status for a bot (current vs available digest). */
  getImageStatus: tenantProcedure.input(z.object({ id: uuidSchema })).query(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    const poller = deps().getImagePoller?.();
    if (!poller) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Image poller not available" });
    }
    return poller.getImageStatus(input.id, profile);
  }),

  /** Trigger an image update for a bot (pull latest image and restart). */
  triggerImageUpdate: tenantProcedure.input(z.object({ id: uuidSchema })).mutation(async ({ input, ctx }) => {
    const fleet = deps().getFleetManager();
    const profile = await fleet.profiles.get(input.id);
    if (!profile || profile.tenantId !== ctx.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
    }
    const updater = deps().getUpdater?.();
    if (!updater) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Updater not available" });
    }
    try {
      return await updater.updateBot(input.id);
    } catch (err) {
      if (err instanceof BotNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: (err as Error).message });
      }
      throw err;
    }
  }),

  /** Dry-run seed preview: lists which bots WOULD be created or skipped based on profile templates.
   *  Does NOT call fleet.create() — no bots are actually created.
   *  Restricted to platform admins (adminProcedure). */
  seed: adminProcedure.mutation(async () => {
    const templates = deps().getTemplates();
    if (templates.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No templates found" });
    }

    const fleet = deps().getFleetManager();
    const profiles = await fleet.profiles.list();
    const existingNames = new Set(profiles.map((p) => p.name));

    const created: string[] = [];
    const skipped: string[] = [];
    for (const template of templates) {
      if (existingNames.has(template.name)) {
        skipped.push(template.name);
      } else {
        existingNames.add(template.name);
        created.push(template.name);
      }
    }

    return { created, skipped };
  }),
});
