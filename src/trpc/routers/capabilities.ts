/**
 * tRPC capabilities router — BYOK/hosted toggle, key validation.
 *
 * Provides typed procedures for managing tenant API keys
 * and validating provider keys.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { CapabilitySettingsStore } from "../../security/tenant-keys/capability-settings-store.js";
import { ALL_CAPABILITIES } from "../../security/tenant-keys/capability-settings-store.js";
import type { EncryptedPayload } from "../../security/types.js";
import { providerSchema } from "../../security/types.js";
import { router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface CapabilitiesRouterDeps {
  getTenantKeyStore: () => {
    listForTenant: (tenantId: string) => unknown[];
    get: (
      tenantId: string,
      provider: string,
    ) =>
      | { id: string; tenant_id: string; provider: string; label: string; created_at: number; updated_at: number }
      | undefined;
    upsert: (tenantId: string, provider: string, encryptedPayload: EncryptedPayload, label: string) => string;
    delete: (tenantId: string, provider: string) => boolean;
  };
  getCapabilitySettingsStore: () => Pick<CapabilitySettingsStore, "listForTenant" | "upsert">;
  encrypt: (plaintext: string, key: Buffer) => EncryptedPayload;
  deriveTenantKey: (tenantId: string, platformSecret: string) => Buffer;
  platformSecret: string | undefined;
  /** Validate a provider API key by calling the provider's API server-side. */
  validateProviderKey: (provider: string, key: string) => Promise<{ valid: boolean; error?: string }>;
}

let _deps: CapabilitiesRouterDeps | null = null;

export function setCapabilitiesRouterDeps(deps: CapabilitiesRouterDeps): void {
  _deps = deps;
}

function deps(): CapabilitiesRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Capabilities not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Capability-to-provider mapping
// ---------------------------------------------------------------------------

const CAPABILITY_BYOK_PROVIDER: Record<string, string | null> = {
  transcription: null,
  "image-gen": null,
  "text-gen": "openai",
  embeddings: "openai",
};

const capabilityNameSchema = z.enum(["transcription", "image-gen", "text-gen", "embeddings"]);
const capabilityModeSchema = z.enum(["hosted", "byok"]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const capabilitiesRouter = router({
  /** List all stored API keys for the authenticated tenant (metadata only). */
  listKeys: tenantProcedure.query(({ ctx }) => {
    const { getTenantKeyStore } = deps();
    const keys = getTenantKeyStore().listForTenant(ctx.tenantId);
    return { keys };
  }),

  /** Check whether a key is stored for a specific provider. */
  getKey: tenantProcedure.input(z.object({ provider: providerSchema })).query(({ input, ctx }) => {
    const { getTenantKeyStore } = deps();
    const record = getTenantKeyStore().get(ctx.tenantId, input.provider);
    if (!record) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No key stored for this provider" });
    }
    return {
      id: record.id,
      tenant_id: record.tenant_id,
      provider: record.provider,
      label: record.label,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }),

  /** Store or replace a tenant API key for a provider. */
  storeKey: tenantProcedure
    .input(
      z.object({
        provider: providerSchema,
        apiKey: z.string().min(1),
        label: z.string().max(100).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getTenantKeyStore, encrypt, deriveTenantKey, platformSecret } = deps();
      if (!platformSecret) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Platform secret not configured" });
      }

      const tenantKey = deriveTenantKey(ctx.tenantId, platformSecret);
      const encryptedPayload = encrypt(input.apiKey, tenantKey);
      const id = getTenantKeyStore().upsert(ctx.tenantId, input.provider, encryptedPayload, input.label ?? "");

      return { ok: true as const, id, provider: input.provider };
    }),

  /** Delete a stored API key. */
  deleteKey: tenantProcedure.input(z.object({ provider: providerSchema })).mutation(({ input, ctx }) => {
    const { getTenantKeyStore } = deps();
    const deleted = getTenantKeyStore().delete(ctx.tenantId, input.provider);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No key stored for this provider" });
    }
    return { ok: true as const, provider: input.provider };
  }),

  /** Validate a provider API key by calling the provider's API server-side. */
  testKey: tenantProcedure
    .input(z.object({ provider: providerSchema, key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { validateProviderKey } = deps();
      try {
        return await validateProviderKey(input.provider, input.key);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to validate key" });
      }
    }),

  /** List capability settings with mode, masked key info for the authenticated tenant. */
  listCapabilitySettings: tenantProcedure.query(({ ctx }) => {
    const { getTenantKeyStore, getCapabilitySettingsStore } = deps();
    const settings = getCapabilitySettingsStore().listForTenant(ctx.tenantId);
    const keys = getTenantKeyStore().listForTenant(ctx.tenantId) as Array<{
      provider: string;
      label: string;
    }>;

    const settingsMap = new Map(settings.map((s) => [s.capability, s]));
    const keysMap = new Map(keys.map((k) => [k.provider, k]));

    return ALL_CAPABILITIES.map((capability) => {
      const setting = settingsMap.get(capability);
      const mode = (setting?.mode ?? "hosted") as "hosted" | "byok";
      const byokProvider = CAPABILITY_BYOK_PROVIDER[capability];
      const keyRecord = byokProvider ? keysMap.get(byokProvider) : undefined;

      return {
        capability,
        mode,
        maskedKey: mode === "byok" && keyRecord?.label ? keyRecord.label : null,
        keyStatus: mode === "byok" && keyRecord ? ("unchecked" as const) : null,
        provider: byokProvider ?? null,
      };
    });
  }),

  /** Update mode (hosted/byok) for a specific capability. */
  updateCapabilitySettings: tenantProcedure
    .input(
      z.object({
        capability: capabilityNameSchema,
        mode: capabilityModeSchema,
        key: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getCapabilitySettingsStore, getTenantKeyStore, encrypt, deriveTenantKey, platformSecret } = deps();

      // Reject BYOK for hosted-only capabilities
      if (input.mode === "byok" && CAPABILITY_BYOK_PROVIDER[input.capability] === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.capability} does not support BYOK mode`,
        });
      }

      // If switching to BYOK with a key, store it
      if (input.mode === "byok" && input.key && platformSecret) {
        const provider = CAPABILITY_BYOK_PROVIDER[input.capability];
        if (provider) {
          const tenantKey = deriveTenantKey(ctx.tenantId, platformSecret);
          const encryptedPayload = encrypt(input.key, tenantKey);
          const maskedLabel = `...${input.key.slice(-4)}`;
          getTenantKeyStore().upsert(ctx.tenantId, provider, encryptedPayload, maskedLabel);
        }
      }

      getCapabilitySettingsStore().upsert(ctx.tenantId, input.capability, input.mode);

      const byokProvider = CAPABILITY_BYOK_PROVIDER[input.capability];
      const keyRecord = byokProvider
        ? (getTenantKeyStore().get(ctx.tenantId, byokProvider) as { label: string } | undefined)
        : undefined;

      return {
        capability: input.capability,
        mode: input.mode,
        maskedKey: input.mode === "byok" && keyRecord?.label ? keyRecord.label : null,
        keyStatus: input.mode === "byok" && keyRecord ? ("unchecked" as const) : null,
        provider: byokProvider ?? null,
      };
    }),
});
